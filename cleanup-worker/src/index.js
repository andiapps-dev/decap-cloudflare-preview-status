// A Cloudflare Worker (not a Pages Function) — Pages has no scheduled-
// execution mechanism of its own; Cron Triggers are a Workers-only
// feature (see wrangler.jsonc's `triggers.crons`), which is why this
// lives as its own small, separately-deployed Worker rather than
// something synced into a Pages project alongside the other pieces of
// this package. Deployed via plain `wrangler deploy` (no git
// integration/Workers Builds involved at all — a different, much simpler
// mechanism than the one that had real bugs elsewhere in this project).
//
// What it does: every Decap editorial-workflow Save creates a Cloudflare
// Pages Preview deployment. Decap cleans up the GitHub side nicely on its
// own (deletes the branch + closes the PR on both Delete and Publish —
// confirmed directly), but Cloudflare never deletes the preview
// deployment itself, so these accumulate forever. Weekly, this lists
// current GitHub branches and current Cloudflare preview deployments, and
// deletes any deployment whose branch no longer exists.
//
// Needs six secrets (wrangler secret put, or dashboard -> Settings ->
// Variables and Secrets on the Worker itself — note this is a Worker, so
// it's a different settings page than the Pages project's):
//   GITHUB_TOKEN            PAT scoped to ONLY "Contents: Read" on the
//                           repo — just enough to list branches, nothing
//                           else. Deliberately narrow, same principle as
//                           every other token in this package.
//   GITHUB_REPO             "<owner>/<repo>".
//   CF_API_TOKEN            Recommend scoped to "Cloudflare Pages: Edit"
//                           (needs delete, not just read, unlike the
//                           token used elsewhere in this package).
//   CF_ACCOUNT_ID
//   CF_PAGES_PROJECT_NAME
//   MANUAL_TRIGGER_TOKEN    Random secret gating the manual /?token=...
//                           HTTP trigger below (testing/on-demand runs
//                           without waiting for the weekly cron) — the
//                           scheduled handler doesn't need this, only the
//                           fetch handler does.

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // don't touch anything newer than this

async function listGithubBranches(env) {
  const branches = new Set();
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/branches?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'decap-preview-cleanup-worker',
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub branches API returned ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (body.length === 0) break;
    for (const b of body) branches.add(b.name);
    if (body.length < 100) break; // last page
    page++;
  }
  return branches;
}

async function listPreviewDeployments(env) {
  const deployments = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}/deployments?env=preview&page=${page}&per_page=25`,
      { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`Cloudflare deployments API returned ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (!body.success) throw new Error(`Cloudflare API request unsuccessful: ${JSON.stringify(body.errors)}`);
    const result = body.result || [];
    if (result.length === 0) break;
    deployments.push(...result);
    if (result.length < 25) break; // last page
    page++;
  }
  return deployments;
}

async function deleteDeployment(env, id) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}/deployments/${id}?force=true`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );
  return res.ok;
}

async function runCleanup(env, { ignoreGracePeriod = false } = {}) {
  const branches = await listGithubBranches(env);
  const deployments = await listPreviewDeployments(env);
  const now = Date.now();

  const deleted = [];
  const skipped = [];

  for (const dep of deployments) {
    const branch = dep.deployment_trigger?.metadata?.branch;

    if (!branch) {
      skipped.push({ id: dep.id, reason: 'no branch metadata' });
      continue;
    }
    // Belt-and-suspenders: never touch the production branch, even though
    // querying env=preview should already exclude it entirely.
    if (branch === 'main' || branch === 'master') {
      skipped.push({ id: dep.id, branch, reason: 'production branch, refusing to touch' });
      continue;
    }
    if (branches.has(branch)) {
      skipped.push({ id: dep.id, branch, reason: 'branch still exists' });
      continue;
    }
    const age = now - new Date(dep.created_on).getTime();
    if (!ignoreGracePeriod && age < GRACE_PERIOD_MS) {
      skipped.push({ id: dep.id, branch, reason: 'within grace period' });
      continue;
    }

    const ok = await deleteDeployment(env, dep.id);
    if (ok) {
      deleted.push({ id: dep.id, branch, created_on: dep.created_on });
    } else {
      skipped.push({ id: dep.id, branch, reason: 'delete request failed' });
    }
  }

  return {
    ranAt: new Date().toISOString(),
    branchesOnGithub: branches.size,
    deploymentsChecked: deployments.length,
    deleted,
    skippedCount: skipped.length,
    skipped,
  };
}

export default {
  async scheduled(event, env, ctx) {
    const results = await runCleanup(env);
    // Cron-triggered runs have no HTTP response to return results in --
    // this is the only place they're visible (Worker Logs in the
    // dashboard, or `wrangler tail`).
    console.log(JSON.stringify(results));
  },

  async fetch(request, env, ctx) {
    // Manual/test trigger — same cleanup logic, runnable on demand
    // without waiting for the weekly cron. Gated by a shared secret query
    // param since this is a real, destructive (deletion) action.
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!env.MANUAL_TRIGGER_TOKEN || token !== env.MANUAL_TRIGGER_TOKEN) {
      return new Response('unauthorized', { status: 401 });
    }
    // Opt-in only, and only reachable here (the scheduled/cron path never
    // passes this) -- the weekly run always keeps the grace period, this
    // is purely for a deliberate one-off "yes, I know what's in here,
    // clean it up now" run.
    const ignoreGracePeriod = url.searchParams.get('ignoreGracePeriod') === 'true';
    try {
      const results = await runCleanup(env, { ignoreGracePeriod });
      return new Response(JSON.stringify(results, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
