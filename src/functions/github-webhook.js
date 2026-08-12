// POST /github-webhook — receives GitHub webhook events for this repo.
//
// Why this exists: Decap CMS's github backend only shows a "Deploy
// Preview" link on workflow entries when it finds a classic GitHub
// *Commit Status* (https://decapcms.org/docs/deploy-preview-links/) whose
// description contains the word "deploy". Cloudflare's GitHub App is only
// granted "checks" + "deployments" + "pull requests" permissions (verified
// directly in the org's installed-app settings) — it never posts a Commit
// Status, so Decap's own UI has nothing to find, no matter what. This
// function bridges the gap: it listens for GitHub's `check_run` event
// (which fires when Cloudflare's own check completes, regardless of which
// app created it), looks up the real preview URL via Cloudflare's API
// (not by trying to parse it out of the webhook payload, which isn't a
// documented/stable shape), and posts a genuine Commit Status back to
// GitHub in the exact form Decap requires. After this, Decap's *native*
// "Check for Preview" / workflow-card UI works correctly for every
// editor, automatically — no custom page, no client-side script.
//
// Also posts a `pending` status the moment the build *starts* (GitHub's
// check_run `created` action), not just when it finishes -- Cloudflare
// builds aren't instant, and without this Decap's UI shows nothing at all
// until completion. With it, editors see "Waiting for build..." right
// away and it flips to a real link once ready, entirely driven by real
// GitHub events rather than any polling on our side.
//
// Reusable as-is for any project following the same Decap-editorial-
// workflow + Cloudflare-Pages-git-integration pattern -- nothing below is
// specific to this repo; everything project-specific comes from env vars.
//
// Needs five env vars (Settings -> Environment variables, Production):
//   GITHUB_WEBHOOK_SECRET  shared secret configured on the GitHub webhook
//                          itself (repo Settings -> Webhooks) — verifies
//                          inbound requests actually come from GitHub.
//   GITHUB_STATUS_TOKEN    a GitHub token scoped to ONLY
//                          "Commit statuses: Read and write" on this repo
//                          — deliberately narrow; this function only ever
//                          needs to post one kind of status, nothing else.
//   GITHUB_REPO            "<owner>/<repo>".
//   CF_PAGES_PROJECT_NAME  the Cloudflare Pages project's own name — not
//                          auto-injected by Cloudflare, has to be set
//                          explicitly.
//   CF_API_TOKEN / CF_ACCOUNT_ID  same ones functions/preview-url.js uses
//                          — recommend a token scoped to ONLY "Cloudflare
//                          Pages: Read", not a broad account-admin token,
//                          since that's all this ever needs.

async function verifySignature(request, secret) {
  const signature = request.headers.get('X-Hub-Signature-256');
  if (!signature || !signature.startsWith('sha256=')) return null;

  const body = await request.text();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const expected = 'sha256=' + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');

  // Constant-time comparison — this is an authenticity check, not worth
  // leaking timing information about how many leading bytes matched.
  if (expected.length !== signature.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0 ? body : null;
}

async function findPreviewUrl(env, branch) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}/deployments?env=preview`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );
  if (!res.ok) return null;
  const body = await res.json();
  if (!body.success) return null;
  const deployment = (body.result || []).find((d) => d.deployment_trigger?.metadata?.branch === branch);
  if (!deployment) return null;
  // Prefer the stable branch-alias URL (e.g.
  // cms-posts-my-slug.<project>.pages.dev) over the per-commit hash
  // URL (e.g. <hash>.<project>.pages.dev) -- the alias always points at the
  // LATEST deployment for this branch, so one bookmarked/posted link stays
  // valid across every subsequent Save on the same draft. The per-commit
  // URL is frozen forever once built, which is exactly what caused
  // real confusion in testing (an old edit's link kept showing old
  // content after a newer edit had already superseded it). Fall back to
  // the per-commit URL only if Cloudflare didn't generate an alias for
  // some reason (e.g. an unusually long branch name).
  return deployment.aliases?.[0] || deployment.url || null;
}

async function postCommitStatus(env, sha, { state, description, target_url }) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/statuses/${sha}`, {
    method: 'POST',
    headers: {
      // .trim() defensively — this value passed through an env var chain
      // (pasted into a terminal, round-tripped through a Cloudflare API
      // PATCH); a stray trailing newline would make the Bearer header
      // silently wrong and GitHub would 401, indistinguishable from a bad
      // token without actually checking the response (which is exactly
      // what bit us in testing: this call used to be fire-and-forget,
      // so a failed POST here looked identical to a successful one).
      Authorization: `Bearer ${env.GITHUB_STATUS_TOKEN.trim()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      // GitHub's API rejects any request with no User-Agent at all
      // (403 "Request forbidden by administrative rules") -- curl sets
      // one by default, which is why a manual curl replica of this exact
      // call worked while this fetch() didn't; Cloudflare's fetch()
      // sends none unless explicitly set. Value doesn't matter, GitHub
      // just requires *a* User-Agent to be present.
      'User-Agent': 'decap-preview-status-webhook',
    },
    body: JSON.stringify({
      state,
      // Decap requires the literal word "deploy" to appear here.
      description,
      target_url,
      context: 'cloudflare-pages/deploy-preview',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub statuses API returned ${res.status}: ${body}`);
  }
}

export async function onRequestPost({ request, env }) {
  if (
    !env.GITHUB_WEBHOOK_SECRET ||
    !env.GITHUB_STATUS_TOKEN ||
    !env.GITHUB_REPO ||
    !env.CF_PAGES_PROJECT_NAME ||
    !env.CF_API_TOKEN ||
    !env.CF_ACCOUNT_ID
  ) {
    return new Response('Missing required env vars', { status: 500 });
  }

  const rawBody = await verifySignature(request, env.GITHUB_WEBHOOK_SECRET);
  if (rawBody === null) {
    return new Response('Invalid signature', { status: 401 });
  }

  const event = request.headers.get('X-GitHub-Event');
  if (event !== 'check_run') {
    // Not an error — just nothing for us to do with other event types.
    // Respond 200 so GitHub doesn't treat this as a delivery failure.
    return new Response('ignored (not check_run)', { status: 200 });
  }

  const payload = JSON.parse(rawBody);
  const checkRun = payload.check_run;
  const appSlug = checkRun?.app?.slug || '';

  if (!appSlug.includes('cloudflare')) {
    return new Response('ignored (not a Cloudflare check)', { status: 200 });
  }
  if (payload.action !== 'created' && payload.action !== 'completed') {
    return new Response('ignored (not created/completed)', { status: 200 });
  }

  const branch = checkRun.check_suite?.head_branch;
  const sha = checkRun.head_sha;
  if (!branch || !branch.startsWith('cms/') || !sha) {
    return new Response('ignored (not a cms/* branch)', { status: 200 });
  }

  // `created` fires the moment Cloudflare's build starts (not when it
  // finishes) -- post a pending status right away so Decap's UI shows
  // "Waiting for build..." immediately instead of nothing at all until
  // the build (which can take a while) finishes. `target_url` points at
  // the check run's own GitHub page (build logs) since there's no preview
  // URL yet at this point.
  if (payload.action === 'created') {
    try {
      await postCommitStatus(env, sha, {
        state: 'pending',
        description: 'Building deploy preview…',
        target_url: checkRun.html_url,
      });
      return new Response('posted pending status', { status: 200 });
    } catch (err) {
      return new Response(`error posting pending status: ${err.message}`, { status: 502 });
    }
  }

  try {
    if (checkRun.conclusion !== 'success') {
      await postCommitStatus(env, sha, {
        state: 'failure',
        description: 'Cloudflare deploy preview build failed',
        target_url: checkRun.html_url,
      });
      return new Response('posted failure status', { status: 200 });
    }
  } catch (err) {
    // Surfaced in the response body (visible in GitHub's own webhook
    // "Recent Deliveries" panel) rather than swallowed, specifically
    // because a silent failure here once looked identical to success.
    return new Response(`error posting failure status: ${err.message}`, { status: 502 });
  }

  const previewUrl = await findPreviewUrl(env, branch);
  if (!previewUrl) {
    // The check completed successfully but the deployment record isn't
    // showing up via the API yet — rather than guess, leave no status
    // rather than post a broken/empty link. A later check_run event (or a
    // subsequent push) will retry this.
    return new Response('check succeeded but no preview URL found yet', { status: 200 });
  }

  try {
    await postCommitStatus(env, sha, {
      state: 'success',
      description: 'Deploy Preview ready',
      target_url: previewUrl,
    });
  } catch (err) {
    return new Response(`error posting success status: ${err.message}`, { status: 502 });
  }

  return new Response('posted success status', { status: 200 });
}
