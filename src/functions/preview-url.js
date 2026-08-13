// Cloudflare Pages Function: GET /preview-url?branch=<branch>
//
// Decap CMS's built-in "deploy preview link" auto-detection (workflow
// board cards) only works against the classic GitHub commit-status API
// with "deploy" in the status description
// (https://decapcms.org/docs/deploy-preview-links/). Cloudflare Pages
// doesn't post that -- it posts a PR *comment* plus GitHub
// Deployments/Environments, neither of which Decap's github backend reads.
// So instead of relying on that, the admin UI (see index.html) calls this
// endpoint directly after every Save to ask Cloudflare's own API for the
// real, current preview URL and show it right there -- no dependency on
// Decap's detection working, and no guessing at Cloudflare's internal
// branch-to-subdomain naming rules (which aren't a stable public contract).
//
// Reusable as-is for any project following the same pattern -- nothing
// below is specific to this repo; everything project-specific comes from
// env vars.
//
// Needs CF_API_TOKEN, CF_ACCOUNT_ID, CF_PAGES_PROJECT_NAME as env vars
// (Settings -> Environment variables, Production -- this only ever runs
// against the live admin, which only exists on the production URL per the
// OAuth callback limitation documented elsewhere). Read-only use (list
// deployments) only -- recommend a Cloudflare API token scoped to just
// "Cloudflare Pages: Read", not a broad account-admin token.

export async function onRequestGet({ request, env }) {
  // Only meant to be called by the admin UI, which itself only loads on
  // the production hostname (see functions/admin/_middleware.js) -- this
  // endpoint has no auth of its own otherwise (it's a read-only lookup,
  // not something requiring a login), so restricting it to the one
  // hostname it's actually used from is real, if modest, defense in
  // depth rather than leaving it answerable from every preview URL too.
  // Response body is a plain 404, not JSON explaining why -- same
  // reasoning as admin/_middleware.js: preview/per-commit *.pages.dev
  // URLs aren't meant to be discoverable, so this shouldn't confirm that
  // anything meaningful lives at this path either.
  if (env.PRODUCTION_HOSTNAME && new URL(request.url).hostname !== env.PRODUCTION_HOSTNAME) {
    return new Response("404 Not Found", { status: 404 });
  }

  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_PAGES_PROJECT_NAME) {
    return new Response(JSON.stringify({ error: 'CF_API_TOKEN/CF_ACCOUNT_ID/CF_PAGES_PROJECT_NAME not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const requestUrl = new URL(request.url);
  const branch = requestUrl.searchParams.get('branch');
  if (!branch) {
    return new Response(JSON.stringify({ error: 'missing branch query param' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  // Optional: only consider deployments strictly newer than this one.
  // Earlier versions of this endpoint just excluded a single baseline id
  // — a real, confirmed bug: with several older already-successful
  // deployments sitting around from prior testing, excluding only the
  // *one* baseline id let `.find()` fall through to the *next*-oldest
  // deployment and report it as "the new build" — which is exactly why
  // "ready" kept appearing within a couple of seconds regardless of how
  // long the real build actually took. Comparing `created_on` timestamps
  // (both sourced from Cloudflare's own API, never the client's clock —
  // no skew risk) instead of a single id is what actually guarantees
  // "genuinely newer than the Save that triggered this poll", not just
  // "not literally identical to one specific earlier deployment".
  const afterId = requestUrl.searchParams.get('after_id');

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}/deployments?env=preview`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } }
  );

  if (!res.ok) {
    return new Response(JSON.stringify({ error: `Cloudflare API error ${res.status}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await res.json();
  if (!body.success) {
    return new Response(JSON.stringify({ error: 'Cloudflare API request unsuccessful', details: body.errors }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const branchDeployments = (body.result || []).filter(
    (d) => d.deployment_trigger?.metadata?.branch === branch
  );

  let afterCreatedOn = null;
  if (afterId) {
    const afterDeployment = branchDeployments.find((d) => d.id === afterId);
    // If the baseline itself isn't found (e.g. it's aged out of the API's
    // result window), there's nothing to compare against — fall back to
    // "no filter" rather than guessing, same as if after_id were omitted.
    if (afterDeployment) afterCreatedOn = new Date(afterDeployment.created_on).getTime();
  }

  // Deployments come back newest-first; take the latest one for this
  // branch that's strictly newer than `after_id`'s own timestamp (if
  // given), so the UI can say "still building" rather than just going
  // quiet, and never mistakes an old already-finished deployment for the
  // one this particular Save just triggered.
  const deployment = branchDeployments.find((d) => {
    if (afterCreatedOn !== null && new Date(d.created_on).getTime() <= afterCreatedOn) return false;
    return true;
  });

  // This is a polling endpoint over fast-changing data (a build's status
  // can flip from "not_found" to "active" to "success" within seconds) --
  // explicitly disable caching so neither the browser nor any
  // intermediate cache ever serves a stale answer to what's meant to be a
  // live check.
  const noCacheHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (!deployment) {
    // Either no deployment exists for this branch at all, or (when
    // `after_id` is set) none is newer than it yet — the caller's job to
    // keep polling in that case, not ours to guess.
    return new Response(JSON.stringify({ status: 'not_found' }), { headers: noCacheHeaders });
  }

  // A deployment moves through several stages (queued -> initialize ->
  // clone_repo -> build -> deploy), and `latest_stage` reports whichever
  // one is CURRENT along with THAT stage's own status -- an early stage
  // like "queued" or "clone_repo" reports "success" the moment IT
  // finishes, long before the deployment as a whole is actually done.
  // Checking `latest_stage.status === 'success'` alone (an earlier bug,
  // caught because it made this endpoint report "ready" the instant a
  // build was merely queued) fires way too early. Only the *final* stage
  // ("deploy") reaching "success" means the deployment is actually live.
  // A "failure" at ANY stage, by contrast, does mean the whole deployment
  // has failed -- no stage-name check needed for that direction.
  const stage = deployment.latest_stage;
  let status;
  if (stage?.status === 'failure') {
    status = 'failure';
  } else if (stage?.name === 'deploy' && stage?.status === 'success') {
    status = 'success';
  } else {
    status = 'building';
  }

  return new Response(
    JSON.stringify({
      id: deployment.id,
      status,
      // The stable branch-alias URL, not the per-commit hash URL -- it
      // stays valid across every subsequent Save on the same draft
      // instead of freezing at whatever content existed the moment it
      // was built. Falls back to the per-commit URL only if Cloudflare
      // didn't generate an alias.
      url: deployment.aliases?.[0] || deployment.url,
    }),
    { headers: noCacheHeaders }
  );
}
