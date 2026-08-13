// A Cloudflare Worker (not a Pages Function) — Pages has no scheduled-
// execution mechanism of its own; Cron Triggers are a Workers-only
// feature (see wrangler.jsonc's `triggers.crons`), which is why this
// lives as its own small, separately-deployed Worker rather than
// something synced into a Pages project alongside the other pieces of
// this package. Deployed via plain `wrangler deploy` (no git
// integration/Workers Builds involved at all — a different, much simpler
// mechanism than the one that had real bugs elsewhere in this project).
//
// What it does, weekly:
//   Preview: every Decap editorial-workflow Save creates a Cloudflare
//     Pages Preview deployment. Decap cleans up the GitHub side nicely on
//     its own (deletes the branch + closes the PR on both Delete and
//     Publish — confirmed directly), but Cloudflare never deletes the
//     preview deployment itself. For each branch that still exists, keeps
//     only its single newest deployment and deletes the older, superseded
//     ones (multiple saves on the same still-open branch otherwise pile
//     up indefinitely). For a branch that no longer exists at all, deletes
//     EVERY deployment for it — there's nothing left to preview.
//   Production: keeps only the single newest production deployment and
//     deletes everything older. Cloudflare always serves live production
//     traffic from the newest one via the stable domain alias, so older
//     ones are pure history/rollback material, not anything currently
//     reachable — deleting them does lose Cloudflare's own one-click
//     "rollback to a previous deployment" from the dashboard, though; a
//     revert is still just a normal `git revert` + push away.
// Both respect the same 24h grace period (skip anything newer than that),
// bypassable via `ignoreGracePeriod` on the manual trigger only — the
// scheduled weekly run never bypasses it.
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

// `cfEnv` is Cloudflare's own deployment environment filter ("preview" or
// "production"), not this Worker's env bindings object.
async function listDeployments(env, cfEnv) {
  const deployments = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}/deployments?env=${cfEnv}&page=${page}&per_page=25`,
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

// Given one logical group of deployments (e.g. one branch's preview
// deployments, or all production deployments), decides which are safe to
// delete: newest-first, keep exactly one (unless `alwaysDeleteAll`, used
// for a preview branch that no longer exists at all -- nothing left to
// keep a "latest" of), and apply the grace period to every candidate.
// Doesn't call the Cloudflare API itself -- just returns the plan, so the
// caller can log/attribute results consistently between the preview
// (per-branch) and production (single group) cases without duplicating
// this logic twice.
function planGroup(deps, { now, ignoreGracePeriod, alwaysDeleteAll, extra }) {
  const toDelete = [];
  const toSkip = [];

  const sorted = [...deps].sort((a, b) => new Date(b.created_on).getTime() - new Date(a.created_on).getTime());
  const candidates = alwaysDeleteAll ? sorted : sorted.slice(1);

  if (!alwaysDeleteAll && sorted.length > 0) {
    toSkip.push({ id: sorted[0].id, ...extra, reason: 'latest in its group, keeping' });
  }

  for (const dep of candidates) {
    const age = now - new Date(dep.created_on).getTime();
    if (!ignoreGracePeriod && age < GRACE_PERIOD_MS) {
      toSkip.push({ id: dep.id, ...extra, reason: 'within grace period' });
    } else {
      toDelete.push(dep);
    }
  }

  return { toDelete, toSkip };
}

async function runCleanup(env, { ignoreGracePeriod = false } = {}) {
  const branches = await listGithubBranches(env);
  const previewDeployments = await listDeployments(env, 'preview');
  const productionDeployments = await listDeployments(env, 'production');
  const now = Date.now();

  const deleted = [];
  const skipped = [];

  // --- Preview: group by branch first. ---
  const byBranch = new Map();
  for (const dep of previewDeployments) {
    const branch = dep.deployment_trigger?.metadata?.branch;
    if (!branch) {
      skipped.push({ id: dep.id, env: 'preview', reason: 'no branch metadata' });
      continue;
    }
    // Belt-and-suspenders: never touch the production branch, even though
    // querying env=preview should already exclude it entirely.
    if (branch === 'main' || branch === 'master') {
      skipped.push({ id: dep.id, env: 'preview', branch, reason: 'production branch, refusing to touch' });
      continue;
    }
    if (!byBranch.has(branch)) byBranch.set(branch, []);
    byBranch.get(branch).push(dep);
  }

  for (const [branch, deps] of byBranch) {
    const branchStillExists = branches.has(branch);
    const { toDelete, toSkip } = planGroup(deps, {
      now,
      ignoreGracePeriod,
      // A gone branch has nothing left to keep a "latest preview" of --
      // every deployment for it is a delete candidate, not just the
      // older ones.
      alwaysDeleteAll: !branchStillExists,
      extra: { env: 'preview', branch },
    });
    skipped.push(...toSkip);
    for (const dep of toDelete) {
      const ok = await deleteDeployment(env, dep.id);
      if (ok) {
        deleted.push({ id: dep.id, env: 'preview', branch, created_on: dep.created_on });
      } else {
        skipped.push({ id: dep.id, env: 'preview', branch, reason: 'delete request failed' });
      }
    }
  }

  // --- Production: one group, no branch concept -- keep only the newest. ---
  {
    const { toDelete, toSkip } = planGroup(productionDeployments, {
      now,
      ignoreGracePeriod,
      alwaysDeleteAll: false,
      extra: { env: 'production' },
    });
    skipped.push(...toSkip);
    for (const dep of toDelete) {
      const ok = await deleteDeployment(env, dep.id);
      if (ok) {
        deleted.push({ id: dep.id, env: 'production', created_on: dep.created_on });
      } else {
        skipped.push({ id: dep.id, env: 'production', reason: 'delete request failed' });
      }
    }
  }

  return {
    ranAt: new Date().toISOString(),
    branchesOnGithub: branches.size,
    deploymentsChecked: previewDeployments.length + productionDeployments.length,
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
