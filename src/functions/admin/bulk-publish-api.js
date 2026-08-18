// Cloudflare Pages Function: GET/POST /admin/bulk-publish-api
//
// Deliberately NOT /admin/bulk-publish -- Cloudflare Pages' "clean URLs"
// feature 308-redirects /admin/bulk-publish.html (the static page this
// Function's own client, public/admin/bulk-publish.html, is served as)
// to the extension-less /admin/bulk-publish, and Functions take priority
// over static assets at the same path. Naming the Function's own route
// bulk-publish.html would have made the static page permanently
// unreachable (every request redirected straight into this Function
// instead) -- exactly the trap already documented and avoided for
// capitaledge's /api/consultation vs /consultation. Confirmed live in
// production before this fix: hitting /admin/bulk-publish.html on both
// djvrx and capitaledge returned this Function's JSON, never the page.
//
// Every Decap Save (publish_mode: editorial_workflow) opens its own
// cms/<collection>/<slug> branch + PR, and each individual "Publish"
// click merges that ONE PR into main -- which Cloudflare Pages builds as
// a real PRODUCTION deployment on every push. A content editor batch-
// editing several unrelated entries currently causes one production
// build per entry. This endpoint lets an editor combine several
// currently-open cms/* PRs into one merge to main -- one production
// build instead of N -- via three states, not one single action:
//
//   OFF -> ON (no scratch) -> ON (scratch, previewable) -> OFF
//
// "Enable" suspends Cloudflare's preview-build-on-push entirely
// (preview_deployment_setting: 'none') -- no build fires for ANY Save,
// not just the ones about to be combined, so an editor can make several
// unrelated edits without each one costing a build. "Combine" merges the
// selected branches into one temporary scratch branch and narrows the
// Cloudflare setting to 'custom' with preview_branch_includes scoped to
// JUST that scratch branch -- individual cms/* edits still build
// nothing, but the deliberately-combined result gets a real preview
// deployment to actually click through before it goes anywhere near
// main. From there: "Publish This" merges the scratch branch into main
// (the one production-triggering push) and restores normal builds, or
// "Abandon" deletes the scratch branch and drops back to the
// no-scratch ON state (bulk mode stays on, nothing published, pick a
// different combination and try again) -- the whole point being able to
// see the combined result and correct course before it's live, not just
// after.
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
//   - Cloudflare side: suspending/restoring/narrowing preview builds is a
//     project-CONFIGURATION change no editor's personal GitHub token
//     could ever authorize -- this genuinely needs its own Cloudflare API
//     secret, unlike every other GitHub-only piece of this design. Kept
//     as its own separately-named, narrowly-scoped env var
//     (CF_PAGES_EDIT_TOKEN, "Pages: Edit" only) rather than widening the
//     existing read-only CF_API_TOKEN that github-webhook.js/
//     preview-url.js use -- widening THEIR token's scope would widen
//     their blast radius for a capability only this function needs.
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
// The exact Cloudflare Pages project-config fields that control preview-
// branch-build behavior (preview_deployment_setting: 'all'/'none'/
// 'custom', preview_branch_includes: string[] when 'custom' -- see
// getBulkState()/setPreviewConfig() below) are this codebase's best
// understanding of Cloudflare's current API, NOT something blindly
// trusted -- it's exactly the kind of API-shape assumption that's
// bitten this project before (see cleanup-worker's own "SUN" vs "0"
// cron-syntax surprise in its README). Verify directly against a real
// project before trusting this in production; the package README's
// "Bugs found" section is the place to record it if this turns out to
// need correcting.

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

// --- Cloudflare: all state (bulk mode on/off, and which scratch branch,
// if any, is currently the previewable combined result) lives entirely
// in the project's own config -- no KV/D1/separate storage, nothing to
// get out of sync with a second source of truth. ---

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

// Three real states, derived from Cloudflare's own config, not tracked
// separately: 'all' -> bulk mode off; 'none' -> bulk mode on, no active
// scratch preview; 'custom' with preview_branch_includes set -> bulk mode
// on, previewing that one scratch branch.
function getBulkState(project) {
  const config = project?.source?.config;
  const setting = config?.preview_deployment_setting;
  if (setting === 'all') return { bulkModeOn: false, scratchBranch: null };
  if (setting === 'custom' && Array.isArray(config?.preview_branch_includes) && config.preview_branch_includes.length > 0) {
    return { bulkModeOn: true, scratchBranch: config.preview_branch_includes[0] };
  }
  return { bulkModeOn: true, scratchBranch: null };
}

// `includes` only matters when setting is 'custom'; omit it otherwise.
// This package's actual target projects (djvrx, capitaledge) are
// documented as always running the normal "all branches preview" resting
// state (preview_branch_includes: ["*"], confirmed in djvrx's README),
// so restoring to the literal value 'all' is correct for them
// specifically -- this is NOT a generic "restore whatever arbitrary
// previous setting existed" mechanism, deliberately simpler than that.
async function setPreviewConfig(env, { setting, includes }) {
  const project = await getProject(env);
  const config = { ...project.source.config, preview_deployment_setting: setting };
  if (includes !== undefined) config.preview_branch_includes = includes;
  const res = await fetch(
    `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}`,
    {
      method: 'PATCH',
      headers: cfHeaders(env),
      body: JSON.stringify({ source: { type: project.source.type, config } }),
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

// Latest preview deployment for one branch -- same shape/reasoning as
// preview-url.js's own lookup (latest_stage reports whichever stage is
// CURRENT, only 'deploy'+'success' means actually live), simplified
// since there's no baseline/after_id race to guard against here (this is
// a one-shot status check on page load, not a poll started right before
// the triggering push).
async function getScratchPreview(env, branch) {
  const res = await fetch(
    `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.CF_PAGES_PROJECT_NAME}/deployments?env=preview`,
    { headers: cfHeaders(env) }
  );
  if (!res.ok) return { status: 'not_found', url: null };
  const body = await res.json();
  if (!body.success) return { status: 'not_found', url: null };
  const deployment = (body.result || []).find((d) => d.deployment_trigger?.metadata?.branch === branch);
  if (!deployment) return { status: 'not_found', url: null };
  const stage = deployment.latest_stage;
  let status;
  if (stage?.status === 'failure') status = 'failure';
  else if (stage?.name === 'deploy' && stage?.status === 'success') status = 'success';
  else status = 'building';
  return { status, url: deployment.aliases?.[0] || deployment.url || null };
}

// --- GitHub: listing/comparing/merging/deleting branches and PRs ---

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

// True if every commit on `branch` is already reachable from
// `scratchBranch` -- i.e. branch's changes are already part of the
// scratch branch's own history. Used to derive "which of the currently-
// open cms/* PRs are actually part of this scratch preview" from GitHub's
// own ancestry data, rather than trusting any client-remembered list --
// robust across a page reload mid-preview, since nothing about this
// depends on browser-held state.
async function isAncestor(env, token, branch, scratchBranch) {
  const res = await fetch(
    `${GITHUB_API}/repos/${env.GITHUB_REPO}/compare/${encodeURIComponent(branch)}...${encodeURIComponent(scratchBranch)}`,
    { headers: githubHeaders(token) }
  );
  if (!res.ok) return false; // fail safe -- never claim it's included if we can't actually tell
  const body = await res.json();
  return body.status === 'identical' || body.status === 'ahead';
}

async function deriveCombinedBranches(env, token, scratchBranch, openPrs) {
  const checked = await Promise.all(
    openPrs.map(async (pr) => ({ branch: pr.branch, included: await isAncestor(env, token, pr.branch, scratchBranch) }))
  );
  return checked.filter((c) => c.included).map((c) => c.branch);
}

// --- The "combine" orchestration: merge each selected branch into one
// new scratch branch, stopping there -- no touch of main, no cleanup.
// Separated from the final publish step so the result can be previewed
// first. ---

async function mergeSelectedIntoScratch(env, token, branches) {
  // Re-validate every requested branch is STILL an open cms/* PR right
  // now -- closes the race where a branch's PR was closed/deleted
  // between the editor loading the list and clicking Combine, and
  // implicitly double-duties as a scope guard against a non-cms/*
  // branch name reaching this far. Nothing has been created yet at this
  // point, so aborting here leaves zero cleanup to do.
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

  return { scratchBranch, merged };
}

export async function onRequestGet({ request, env }) {
  const missing = missingEnv(env);
  if (missing) return jsonError(500, `${missing} not configured`);

  let project;
  try {
    project = await getProject(env);
  } catch (err) {
    return jsonError(502, `could not read Cloudflare project state: ${err.message}`);
  }
  const { bulkModeOn, scratchBranch } = getBulkState(project);

  const token = extractToken(request);
  let prs = [];
  if (token) {
    try {
      prs = await listOpenCmsPulls(env, token);
    } catch (err) {
      return jsonError(502, `could not list open cms/* PRs: ${err.message}`);
    }
  }

  let scratch = null;
  if (scratchBranch) {
    const combinedBranches = token ? await deriveCombinedBranches(env, token, scratchBranch, prs) : [];
    const preview = await getScratchPreview(env, scratchBranch);
    scratch = { branch: scratchBranch, combinedBranches, preview };
  }

  return jsonResponse({ bulkModeOn, repo: env.GITHUB_REPO, prs, scratch });
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
      await setPreviewConfig(env, { setting: 'none' });
    } catch (err) {
      return jsonError(502, `could not enable bulk mode: ${err.message}`);
    }
    return jsonResponse({ bulkModeOn: true });
  }

  if (body.action === 'disable') {
    // Refuses to disable out from under an active scratch preview --
    // that would leave the scratch branch orphaned (nothing would ever
    // clean it up) while re-enabling normal builds for everything else,
    // a confusing half-state. Publish or Abandon it first.
    let state;
    try {
      state = getBulkState(await getProject(env));
    } catch (err) {
      return jsonError(502, `could not read Cloudflare project state: ${err.message}`);
    }
    if (state.scratchBranch) {
      return jsonError(409, `a combined preview is active on branch '${state.scratchBranch}' -- Publish or Abandon it before disabling Bulk Mode.`);
    }
    try {
      await setPreviewConfig(env, { setting: 'all' });
    } catch (err) {
      return jsonError(502, `could not disable bulk mode: ${err.message}`);
    }
    return jsonResponse({ bulkModeOn: false });
  }

  if (body.action === 'combine') {
    const token = extractToken(request);
    if (!token) return jsonError(401, 'missing bearer token');

    const branches = Array.isArray(body.branches) ? [...new Set(body.branches)] : [];
    if (branches.length === 0) return jsonError(400, 'branches must be a non-empty array');

    let state;
    try {
      state = getBulkState(await getProject(env));
    } catch (err) {
      return jsonError(502, `could not read Cloudflare project state: ${err.message}`);
    }
    if (state.scratchBranch) {
      return jsonError(409, `a combined preview is already active on branch '${state.scratchBranch}' -- Publish or Abandon it first.`);
    }

    let result;
    try {
      result = await mergeSelectedIntoScratch(env, token, branches);
    } catch (err) {
      return jsonError(502, `combine failed: ${err.message} -- bulk mode is still ON, nothing was restored`);
    }
    if (result.response) return result.response;

    try {
      await setPreviewConfig(env, { setting: 'custom', includes: [result.scratchBranch] });
    } catch (err) {
      return jsonError(
        502,
        `combine succeeded (scratch branch '${result.scratchBranch}') but enabling its preview build failed: ${err.message}`,
        { scratchBranch: result.scratchBranch, combinedBranches: result.merged }
      );
    }

    return jsonResponse({ scratchBranch: result.scratchBranch, combinedBranches: result.merged });
  }

  if (body.action === 'publish-scratch' || body.action === 'abandon-scratch') {
    const token = extractToken(request);
    if (!token) return jsonError(401, 'missing bearer token');

    const scratchBranch = body.scratchBranch;
    if (!scratchBranch) return jsonError(400, 'missing scratchBranch');

    let state;
    try {
      state = getBulkState(await getProject(env));
    } catch (err) {
      return jsonError(502, `could not read Cloudflare project state: ${err.message}`);
    }
    if (state.scratchBranch !== scratchBranch) {
      return jsonError(
        409,
        `'${scratchBranch}' is not the currently active combined preview (current: ${state.scratchBranch || 'none'}) -- refresh and try again.`
      );
    }

    if (body.action === 'abandon-scratch') {
      if (!(await deleteBranch(env, token, scratchBranch))) {
        return jsonError(502, `could not delete scratch branch '${scratchBranch}'`);
      }
      try {
        await setPreviewConfig(env, { setting: 'none' });
      } catch (err) {
        return jsonError(502, `scratch branch deleted but resetting the preview config failed: ${err.message} -- bulk mode may still show the old scratch branch, try again`);
      }
      return jsonResponse({ bulkModeOn: true, scratchBranch: null });
    }

    // publish-scratch: derive which branches are actually part of this
    // scratch from GitHub's own ancestry data (not a client-supplied
    // list) -- correct even if the page was reloaded since Combine ran.
    let openPrs;
    try {
      openPrs = await listOpenCmsPulls(env, token);
    } catch (err) {
      return jsonError(502, `could not list open cms/* PRs: ${err.message}`);
    }
    const combinedBranches = await deriveCombinedBranches(env, token, scratchBranch, openPrs);

    const finalMerge = await mergeBranch(
      env,
      token,
      'main',
      scratchBranch,
      `Bulk publish: ${combinedBranches.length} ${combinedBranches.length === 1 ? 'entry' : 'entries'} (${combinedBranches.join(', ')})`
    );
    if (!finalMerge.ok) {
      // Shouldn't normally happen -- main didn't move since Combine ran
      // -- but if it did, leave the scratch branch in place, same
      // reasoning as every other conflict path in this file.
      return jsonError(409, `merge conflict publishing scratch branch '${scratchBranch}' into main -- resolve manually. Scratch branch left in place.`, { scratchBranch });
    }

    // Cleanup. Do NOT explicitly close/merge the original PRs via the
    // pulls API -- GitHub auto-detects that each open PR's head-branch
    // commits are now ancestors of main (mergeBranch's merge commits
    // preserve the original SHAs) and marks each PR "Merged" on its own,
    // the exact same end state Decap's own individual Publish leaves.
    // Deliberate, not a bug to "fix" later by adding an explicit close
    // call -- an explicit close (as opposed to merge) would actually be
    // WRONG, marking a PR "Closed" instead of "Merged" for something
    // that did land.
    const warnings = [];
    if (!(await deleteBranch(env, token, scratchBranch))) {
      warnings.push(`could not delete scratch branch '${scratchBranch}' -- harmless, delete manually if desired`);
    }
    for (const branch of combinedBranches) {
      if (!(await deleteBranch(env, token, branch))) {
        warnings.push(`could not delete branch '${branch}' -- harmless, delete manually if desired`);
      }
    }

    try {
      await setPreviewConfig(env, { setting: 'all' });
    } catch (err) {
      // The publish itself succeeded -- this is a worse situation than
      // enable failing, since it means bulk mode is now stuck ON with no
      // automatic retry despite the actual publish having worked. Say so
      // explicitly rather than reporting a clean success that isn't
      // fully true.
      return jsonResponse(
        {
          published: combinedBranches,
          mainMergeSha: finalMerge.sha,
          warnings,
          repo: env.GITHUB_REPO,
          bulkModeOn: true,
          error: `publish succeeded but restoring normal preview builds failed: ${err.message} -- bulk mode is still ON, try again or fix manually in the Cloudflare dashboard`,
        },
        200
      );
    }

    return jsonResponse({ published: combinedBranches, mainMergeSha: finalMerge.sha, warnings, repo: env.GITHUB_REPO, bulkModeOn: false });
  }

  return jsonError(400, `unknown action '${body.action}' -- expected 'enable', 'disable', 'combine', 'publish-scratch', or 'abandon-scratch'`);
}
