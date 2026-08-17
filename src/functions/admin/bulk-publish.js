// Cloudflare Pages Function: GET/POST /admin/bulk-publish
//
// Every Decap Save (publish_mode: editorial_workflow) opens its own
// cms/<collection>/<slug> branch + PR, and each individual "Publish"
// click merges that ONE PR into main -- which Cloudflare Pages builds as
// a real PRODUCTION deployment on every push. A content editor batch-
// editing several unrelated entries currently causes one production
// build per entry. This endpoint lets an editor combine several
// currently-open cms/* PRs into a single merge to main -- one production
// build instead of N -- and, while "Bulk Mode" is on, suspends Cloudflare
// Pages' own preview-build-on-push behavior entirely, so not even the
// individual per-entry Saves made during the batch trigger a build.
//
// Two very different credentials are in play here, deliberately:
//   - GitHub side: this function has NO env.*-sourced GitHub token of
//     its own. Every GitHub call uses the CALLER's own token, forwarded
//     via this request's Authorization header -- the same token Decap
//     CMS's own browser-side code already holds after OAuth login
//     (public/admin/bulk-publish.html reads it straight out of Decap's
//     own localStorage, see that file's own comments). GitHub's own
//     permission check on that token is the entire authorization gate;
//     attribution for the merges/branch-deletes follows whoever actually
//     clicked the button, same as their individual Saves today.
//   - Cloudflare side: suspending/restoring preview builds is a project-
//     CONFIGURATION change no editor's personal GitHub token could ever
//     authorize -- this genuinely needs its own Cloudflare API secret,
//     unlike every other GitHub-only piece of this design. Kept as its
//     own separately-named, narrowly-scoped env var (CF_PAGES_EDIT_TOKEN,
//     "Pages: Edit" only) rather than widening the existing read-only
//     CF_API_TOKEN that github-webhook.js/preview-url.js use -- widening
//     THEIR token's scope would widen their blast radius for a
//     capability only this function needs.
//
// Placed under functions/admin/ specifically so it inherits
// admin/_middleware.js's existing PRODUCTION_HOSTNAME gating
// automatically (that middleware is scoped to its whole directory, no
// path logic of its own) -- no duplicated hostname check needed here.
//
// Needs:
//   GITHUB_REPO            "<owner>/<repo>" -- reused, not a new name.
//   CF_PAGES_EDIT_TOKEN     Cloudflare API token scoped to ONLY
//                          "Cloudflare Pages: Edit" on this one project.
//   CF_ACCOUNT_ID / CF_PAGES_PROJECT_NAME  reused, not new names.
//
// The exact Cloudflare Pages project-config field that controls preview-
// branch-build behavior (preview_deployment_setting, values 'all' /
// 'none' / 'custom' -- see isBulkModeOn()/setPreviewDeploymentSetting()
// below) is this codebase's best understanding of Cloudflare's current
// API, NOT something blindly trusted -- it's exactly the kind of API-
// shape assumption that's bitten this project before (see
// cleanup-worker's own "SUN" vs "0" cron-syntax surprise in its README).
// Verify it directly against a real GET on a real project before
// trusting this in production; the package README's "Bugs found"
// section is the place to record it if this turns out to need
// correcting.

const GITHUB_API = 'https://api.github.com';
const CF_API = 'https://api.cloudflare.com/client/v4';
const CMS_BRANCH_PREFIX = 'cms/';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function jsonError(status, message, extra) {
  return jsonResponse({ error: message, ...extra }, status);
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token.trim()}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'decap-bulk-publish',
  };
}

function cfHeaders(env) {
  return {
    Authorization: `Bearer ${env.CF_PAGES_EDIT_TOKEN.trim()}`,
    'Content-Type': 'application/json',
  };
}

function extractToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function missingEnv(env) {
  if (!env.GITHUB_REPO) return 'GITHUB_REPO';
  if (!env.CF_PAGES_EDIT_TOKEN) return 'CF_PAGES_EDIT_TOKEN';
  if (!env.CF_ACCOUNT_ID) return 'CF_ACCOUNT_ID';
  if (!env.CF_PAGES_PROJECT_NAME) return 'CF_PAGES_PROJECT_NAME';
  return null;
}

// --- Cloudflare: bulk-mode state lives entirely in the project's own
// config -- no KV/D1/separate storage, nothing to get out of sync with a
// second source of truth. ---

async function getProject(env) {
  const res = await fetch(
    `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}`,
    { headers: cfHeaders(env) }
  );
  if (!res.ok) {
    throw new Error(`Cloudflare projects API returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Cloudflare API request unsuccessful: ${JSON.stringify(body.errors)}`);
  }
  return body.result;
}

function isBulkModeOn(project) {
  return project?.source?.config?.preview_deployment_setting === 'none';
}

// Only ever called with 'none' (enable) or 'all' (restore) -- this
// package's actual target projects (djvrx, capitaledge) are documented
// as always running the normal "all branches preview" resting state
// (preview_branch_includes: ["*"], confirmed in djvrx's README), so
// restoring to the literal value 'all' is correct for them specifically
// -- this is NOT a generic "restore whatever arbitrary previous setting
// existed" mechanism, deliberately simpler than that.
async function setPreviewDeploymentSetting(env, setting) {
  const project = await getProject(env);
  const res = await fetch(
    `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}`,
    {
      method: 'PATCH',
      headers: cfHeaders(env),
      body: JSON.stringify({
        source: {
          type: project.source.type,
          config: { ...project.source.config, preview_deployment_setting: setting },
        },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Cloudflare projects PATCH returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Cloudflare API request unsuccessful: ${JSON.stringify(body.errors)}`);
  }
}

// --- GitHub: listing/merging/deleting branches and PRs ---

async function listOpenCmsPulls(env, token) {
  const prs = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `${GITHUB_API}/repos/${env.GITHUB_REPO}/pulls?state=open&per_page=100&page=${page}`,
      { headers: githubHeaders(token) }
    );
    if (!res.ok) {
      throw new Error(`GitHub pulls API returned ${res.status}: ${await res.text()}`);
    }
    const body = await res.json();
    if (body.length === 0) break;
    prs.push(...body);
    if (body.length < 100) break;
    page++;
  }
  return prs
    .filter((pr) => pr.head?.ref?.startsWith(CMS_BRANCH_PREFIX))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.head.ref,
      updatedAt: pr.updated_at,
      author: pr.user?.login || null,
      url: pr.html_url,
    }));
}

async function getMainSha(env, token) {
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/git/ref/heads/main`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`could not read main ref: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body.object.sha;
}

async function createBranch(env, token, name, sha) {
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/git/refs`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
  });
  if (!res.ok) {
    throw new Error(`could not create scratch branch: ${res.status} ${await res.text()}`);
  }
}

// Returns { ok: true, sha } on success, { ok: false, conflict: true } on
// a real 409 conflict, or throws on any other failure -- callers
// distinguish "expected, handle gracefully" from "genuinely broken".
async function mergeBranch(env, token, base, head, commitMessage) {
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/merges`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ base, head, commit_message: commitMessage }),
  });
  if (res.status === 409) {
    return { ok: false, conflict: true };
  }
  if (!res.ok) {
    throw new Error(`GitHub merges API returned ${res.status} merging '${head}' into '${base}': ${await res.text()}`);
  }
  const body = await res.json();
  return { ok: true, sha: body.sha };
}

async function deleteBranch(env, token, name) {
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/git/refs/heads/${name}`, {
    method: 'DELETE',
    headers: githubHeaders(token),
  });
  return res.ok;
}

// --- The orchestration itself ---

async function combineAndPublish(env, token, branches) {
  // Step 0: re-validate every requested branch is STILL an open cms/*
  // PR right now -- closes the race where a branch's PR was
  // closed/deleted between the editor loading the list and clicking
  // publish, and implicitly double-duties as a scope guard against a
  // non-cms/* branch name reaching this far. Nothing has been created
  // yet at this point, so aborting here leaves zero cleanup to do.
  const openPrs = await listOpenCmsPulls(env, token);
  const openBranches = new Set(openPrs.map((pr) => pr.branch));
  for (const branch of branches) {
    if (!openBranches.has(branch)) {
      return {
        response: jsonError(
          409,
          `branch '${branch}' is no longer an open cms/* PR -- it may have been published, closed, or deleted by someone else. Refresh the list and try again.`
        ),
      };
    }
  }

  const mainSha = await getMainSha(env, token);
  const scratchBranch = `bulk-publish-${Date.now()}`;
  await createBranch(env, token, scratchBranch, mainSha);

  const merged = [];
  for (const branch of branches) {
    const result = await mergeBranch(env, token, scratchBranch, branch, `Bulk publish: merge ${branch}`);
    if (!result.ok) {
      // Real conflict. Leave the scratch branch in place on purpose --
      // it's the only artifact showing exactly how far the combine got
      // and which branch broke it; deleting it here would destroy the
      // one useful piece of debugging evidence, and it costs nothing to
      // leave (main is never touched in this path).
      return {
        response: jsonError(409, `merge conflict combining '${branch}' into scratch branch '${scratchBranch}' -- resolve manually or publish it individually. Scratch branch left in place at '${scratchBranch}' for inspection.`, {
          conflictedBranch: branch,
          scratchBranch,
          alreadyMerged: merged,
        }),
      };
    }
    merged.push(branch);
  }

  // The one production-triggering push.
  const finalMerge = await mergeBranch(
    env,
    token,
    'main',
    scratchBranch,
    `Bulk publish: ${merged.length} ${merged.length === 1 ? 'entry' : 'entries'} (${merged.join(', ')})`
  );
  if (!finalMerge.ok) {
    // Also leave the scratch branch in place -- same reasoning, doubly
    // so here since this is the very last step.
    return {
      response: jsonError(409, `merge conflict combining scratch branch '${scratchBranch}' into main -- this shouldn't normally happen since main didn't move during the combine, but if it did, resolve manually. Scratch branch left in place.`, {
        scratchBranch,
        alreadyMerged: merged,
      }),
    };
  }

  // Cleanup. Do NOT explicitly close/merge the original PRs via the
  // pulls API -- GitHub auto-detects that each open PR's head-branch
  // commits are now ancestors of main (mergeBranch's merge commits
  // preserve the original SHAs) and marks each PR "Merged" on its own,
  // the exact same end state Decap's own individual Publish leaves.
  // Deliberate, not a bug to "fix" later by adding an explicit close
  // call -- an explicit close (as opposed to merge) would actually be
  // WRONG, marking a PR "Closed" instead of "Merged" for something that
  // did land.
  const warnings = [];
  if (!(await deleteBranch(env, token, scratchBranch))) {
    warnings.push(`could not delete scratch branch '${scratchBranch}' -- harmless, delete manually if desired`);
  }
  for (const branch of merged) {
    if (!(await deleteBranch(env, token, branch))) {
      warnings.push(`could not delete branch '${branch}' -- harmless, delete manually if desired`);
    }
  }

  return {
    published: merged,
    mainMergeSha: finalMerge.sha,
    warnings,
  };
}

export async function onRequestGet({ request, env }) {
  const missing = missingEnv(env);
  if (missing) return jsonError(500, `${missing} not configured`);

  let bulkModeOn;
  try {
    bulkModeOn = isBulkModeOn(await getProject(env));
  } catch (err) {
    return jsonError(502, `could not read Cloudflare project state: ${err.message}`);
  }

  const token = extractToken(request);
  let prs = [];
  if (token) {
    try {
      prs = await listOpenCmsPulls(env, token);
    } catch (err) {
      return jsonError(502, `could not list open cms/* PRs: ${err.message}`);
    }
  }

  return jsonResponse({ bulkModeOn, repo: env.GITHUB_REPO, prs });
}

export async function onRequestPost({ request, env }) {
  const missing = missingEnv(env);
  if (missing) return jsonError(500, `${missing} not configured`);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'malformed request body');
  }

  if (body.action === 'enable') {
    try {
      await setPreviewDeploymentSetting(env, 'none');
    } catch (err) {
      return jsonError(502, `could not enable bulk mode: ${err.message}`);
    }
    return jsonResponse({ bulkModeOn: true });
  }

  if (body.action === 'disable-and-publish') {
    const token = extractToken(request);
    if (!token) return jsonError(401, 'missing bearer token');

    const branches = Array.isArray(body.branches) ? [...new Set(body.branches)] : [];

    if (branches.length === 0) {
      // Editor just wants to turn bulk mode back off without publishing
      // anything -- a distinct, simpler path than the full orchestration.
      try {
        await setPreviewDeploymentSetting(env, 'all');
      } catch (err) {
        return jsonError(502, `could not disable bulk mode: ${err.message}`);
      }
      return jsonResponse({ bulkModeOn: false, published: [] });
    }

    let result;
    try {
      result = await combineAndPublish(env, token, branches);
    } catch (err) {
      // Genuinely unexpected failure (not one of the handled 409 paths,
      // which return early with their own Response). Bulk mode stays ON
      // -- restoring it here would let unrelated future Saves start
      // building previews again while this batch may be in a broken,
      // half-merged state, which is worse than leaving it suspended a
      // little longer.
      return jsonError(502, `bulk publish failed: ${err.message} -- bulk mode is still ON, nothing was restored`);
    }
    if (result.response) {
      // One of combineAndPublish's own handled failure paths (409s) --
      // bulk mode deliberately stays ON, same reasoning as above.
      return result.response;
    }

    // Full success -- now, and only now, restore normal preview builds.
    try {
      await setPreviewDeploymentSetting(env, 'all');
    } catch (err) {
      // The publish itself succeeded -- this is a worse situation than
      // enable failing, since it means bulk mode is now stuck ON with no
      // automatic retry despite the actual publish having worked. Say so
      // explicitly rather than reporting a clean success that isn't
      // fully true.
      return jsonResponse(
        {
          ...result,
          repo: env.GITHUB_REPO,
          bulkModeOn: true,
          error: `publish succeeded but restoring normal preview builds failed: ${err.message} -- bulk mode is still ON, try Enable/Disable again or fix manually in the Cloudflare dashboard`,
        },
        200
      );
    }

    return jsonResponse({ ...result, repo: env.GITHUB_REPO, bulkModeOn: false });
  }

  return jsonError(400, `unknown action '${body.action}' -- expected 'enable' or 'disable-and-publish'`);
}
