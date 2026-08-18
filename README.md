# decap-cloudflare-preview-status

Makes Decap CMS's `editorial_workflow` + Cloudflare Pages show accurate,
real-time build status to editors — both Decap's own native "Check for
Preview" UI, and a prominent in-admin banner.

Also includes [`cleanup-worker/`](./cleanup-worker), a small, separately
deployed Cloudflare Worker (Cron Trigger, not part of the Pages project)
that periodically deletes superseded preview and production
deployments — every Save creates a new preview deployment, every merge to
`main` creates a new production one, and Cloudflare never cleans up either
on its own.

Also includes **Bulk Publish** (`/admin/bulk-publish.html`) — lets an
editor combine several currently-open `cms/*` PRs into a single merge to
`main`, producing exactly one production build instead of one per entry,
and optionally suspends Cloudflare's preview builds entirely while a
batch of edits is in progress. See "Bulk Publish" below.

## Prerequisites

- Decap CMS with `backend: { name: github, ... }` and
  `publish_mode: editorial_workflow` — every Save opens a real branch/PR.
- Classic Cloudflare **Pages** (not Workers Builds — the latter is a
  different, git-connected-Worker product living under the same
  dashboard section, and has had reliability issues with non-production
  branches not triggering builds at all), connected to the GitHub repo
  via native Git integration.

## Why this exists

Decap's `github` backend only shows a "Check for Preview" link when it
finds a classic GitHub **Commit Status** API entry
([docs](https://decapcms.org/docs/deploy-preview-links/)) whose
description contains the word "deploy". Cloudflare's GitHub App is only
granted `checks` + `deployments` + `pull requests` permissions — it posts
a PR comment and GitHub Deployments/Checks, **never** a Commit Status. So
Decap's native feature has nothing to find on a Cloudflare-Pages project —
this isn't a misconfiguration, it's a real, permanent gap between the two
products.

`functions/github-webhook.js` bridges it: listens for GitHub's `check_run`
event (fires when Cloudflare's own check starts and completes) and posts a
real Commit Status back in the exact shape Decap needs.

Even with that working, Decap's own UI doesn't refresh live while you stay
on the same page, and Cloudflare's deployment API has sharp edges that
produce **wrong** answers if queried naively (see "Bugs found" below) — so
`public/admin/preview-status.js` polls a dedicated lookup endpoint
(`functions/preview-url.js`) itself and shows its own accurate, timestamped
banner, rather than depending on Decap's UI refreshing.

## Install

```bash
npm install github:andiapps-dev/decap-cloudflare-preview-status
```

Add a postinstall hook to your own `package.json` so every `npm install`/
`npm ci` re-syncs the files (this is how updates propagate — `npm update`
then genuinely pulls in fixes):

```json
{
  "scripts": {
    "postinstall": "node node_modules/decap-cloudflare-preview-status/scripts/sync.mjs"
  }
}
```

This copies (overwrites, on every install):
- `functions/github-webhook.js`
- `functions/preview-url.js`
- `functions/admin/_middleware.js`
- `public/admin/preview-status.js`
- `functions/admin/bulk-publish-api.js`
- `public/admin/bulk-publish.html`

**Don't hand-edit these** — they're regenerated on every install. Fix bugs
upstream in this package, bump the version, `npm update` in the consumer.

Wire the client script into your `public/admin/index.html`:

```html
<script src="/admin/preview-status.js"></script>
```

(after the `decap-cms.js` script tag)

## Env vars (Cloudflare Pages → Settings → Environment variables)

| Var | Environments | Used by | Notes |
|---|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | Production only | `github-webhook.js` | Random secret, e.g. `openssl rand -hex 32`. Also configured on the GitHub webhook itself (see below). GitHub only ever calls the production URL, so Preview never needs this. |
| `GITHUB_STATUS_TOKEN` | Production only | `github-webhook.js` | GitHub PAT scoped to **only** "Commit statuses: Read and write" on the one repo. Deliberately narrow. |
| `GITHUB_REPO` | Production only | `github-webhook.js` | `"<owner>/<repo>"`. |
| `CF_PAGES_PROJECT_NAME` | Production only | `github-webhook.js`, `preview-url.js` | The Cloudflare Pages project's own name. Not auto-injected by Cloudflare. |
| `CF_API_TOKEN` | Production only | `github-webhook.js`, `preview-url.js` | **Recommend a token scoped to only "Cloudflare Pages: Read"**, not a broad account-admin token — that's all this ever needs. |
| `CF_ACCOUNT_ID` | Production only | `github-webhook.js`, `preview-url.js` | |
| `PRODUCTION_HOSTNAME` | **Both** Production and Preview | `admin/_middleware.js`, `preview-url.js` | Your production Pages hostname. Blocks `/admin` and `/preview-url` on every other hostname (preview URLs, per-commit URLs). The one var that genuinely needs to exist on Preview too — its whole job is running *there* to detect and block it. Optional: if unset, nothing is blocked (fails open). |
| `CF_PAGES_EDIT_TOKEN` | Production only | `bulk-publish-api.js` | Cloudflare API token scoped to **only "Cloudflare Pages: Edit"** on this one project — a deliberately different, more privileged token than the Read-only `CF_API_TOKEN` above, kept separate so widening this one's scope never widens `github-webhook.js`/`preview-url.js`'s. Needed to suspend/restore preview builds; `bulk-publish-api.js`'s GitHub-side calls use the *caller's own* GitHub token instead (see "Bulk Publish" below), not a fixed secret. |

Why only `PRODUCTION_HOSTNAME` needs both: everything else is only ever
reached via the production URL in practice — the GitHub webhook always
calls the one URL configured on it, and `preview-url.js`'s hostname check
runs *before* it would ever need the other vars, so a preview deployment
missing them fails safe (blocked by hostname) rather than erroring.

## GitHub webhook setup (once per repo)

Repo → Settings → Webhooks → Add webhook:
- Payload URL: `https://<your-production-hostname>/github-webhook`
- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET` above
- Events: "Let me select individual events" → check only **Check runs**

## Bulk Publish

Every Decap Save opens its own `cms/<collection>/<slug>` branch + PR, and
each individual "Publish" click merges that ONE PR into `main` — which
Cloudflare Pages builds as a real **production** deployment on every
push. An editor batch-editing several unrelated entries currently causes
one production build per entry, even though it's conceptually one
editing session. Bulk Publish (`/admin/bulk-publish.html`) lets an editor
combine several currently-open `cms/*` PRs into a single merge to `main`
instead — one production build, not N.

**How to use it**: log into `/admin` first (Bulk Publish reuses that
session's GitHub token, no separate login), visit
`/admin/bulk-publish.html`, click **Enable Bulk Mode**, make your edits
normally in `/admin`, come back, check which entries to combine, and
click **Combine, Publish & Turn Off Bulk Mode**.

The Function backing this page lives at `/admin/bulk-publish-api`, not
the more obvious `/admin/bulk-publish` — deliberately. Cloudflare Pages'
"clean URLs" feature 308-redirects `/admin/bulk-publish.html` (the
static page) to the extension-less `/admin/bulk-publish`, and Functions
take priority over static assets at the same path — naming the Function
`/admin/bulk-publish` would have made the page permanently unreachable,
every request redirected straight into the Function instead of ever
rendering. Caught live in production before being caught here first;
worth knowing before "simplifying" this naming later.

**"Enable Bulk Mode" suspends ALL Cloudflare builds, not just batches the
final one** — while it's on, *no* build fires for *any* Save, not just
the ones you're about to combine (this is a project-wide Cloudflare Pages
setting, not scoped to one editor's session). Every individual Save still
creates its normal `cms/*` branch + PR exactly as always — nothing about
Decap's own behavior changes — it just doesn't trigger a build until you
publish. Once you combine-and-publish, Bulk Mode turns back off and
everything resumes exactly as it was.

**A failed publish deliberately leaves Bulk Mode ON** — restoring normal
builds on a failed/partial publish would let unrelated future Saves start
building previews again while that batch is still in a broken, half-
merged state. This is expected, not a stuck/broken toggle; re-run
Combine & Publish (or "Turn Off Bulk Mode" without publishing) once
resolved.

**Two very different credentials, deliberately**: the GitHub side (list/
merge/delete branches) uses the *editor's own* GitHub token — the same
one Decap's own browser code already holds after OAuth login, read
straight out of its `localStorage` entry — not a fixed secret. GitHub's
own permission check on that token is the authorization gate, and
attribution follows whoever clicked the button, same as their individual
Saves today. The Cloudflare side (suspending/restoring preview builds) is
a project-configuration change no personal GitHub token could ever
authorize, so it genuinely needs its own secret — `CF_PAGES_EDIT_TOKEN`,
scoped to **Cloudflare Pages: Edit** only, kept deliberately separate
from the Read-only `CF_API_TOKEN` used elsewhere in this package.

**Under the hood** (why exactly one production build, not one per
combined entry): calling GitHub's per-PR merge endpoint N times would
still be N separate pushes to `main`. Instead, each selected branch gets
merged into one temporary scratch branch first (a real, server-side
3-way merge via GitHub's own "Merge a branch" API — not a reimplemented
diff), and only that single scratch branch gets merged into `main` at
the end. **The original PRs are never explicitly closed or merged via
the API** — GitHub auto-detects that each open PR's commits are now
ancestors of `main` (the scratch-branch merges preserve the original
commit SHAs) and marks each one "Merged" on its own, the same end state
an individual Decap Publish leaves. **This is deliberate, not a bug** —
if you're investigating and see PRs marked Merged with no merge commit
of their own referencing them individually, this is why.

On a real conflict (most likely: two selected branches both editing the
same single-file collection, e.g. `settings/site.json` — every other
collection is one-file-per-entry so this is the realistic failure mode),
the whole operation aborts, nothing already published is touched, and the
temporary scratch branch is deliberately left in place (not deleted) so
it's inspectable — delete it manually via GitHub once resolved; a future
`cleanup-worker` enhancement could target `bulk-publish-*` branches, but
doesn't yet.

## GitHub/Cloudflare status widget

`public/admin/preview-status.js` also shows a small, persistent indicator
in the bottom-right corner of every `/admin` page — GitHub's and
Cloudflare's own current status (✅ operational, ⚠️ minor/major incident,
❌ critical, ❔ couldn't check), checked once on page load and every 15
minutes after. Both use the real, public [Atlassian Statuspage
API](https://www.atlassian.com/software/statuspage) GitHub and Cloudflare
each publish (`githubstatus.com`/`cloudflarestatus.com`'s own
`/api/v2/status.json`) — confirmed directly that both send
`Access-Control-Allow-Origin: *`, i.e. they're deliberately meant to be
fetched client-side like this. No token, no server-side Function, no new
env var of any kind — this is the simplest piece of the whole package.

Useful on its own (a quick "is it them or is it me" check when something
seems broken) and specifically relevant to Bulk Publish above: if GitHub
or Cloudflare is degraded, that's worth knowing before enabling Bulk Mode
or trying to combine-and-publish, since the whole feature depends on both
being reachable and behaving normally.

## Bugs found building this (why the code looks the way it does)

Five distinct, real bugs surfaced during development — each one is
documented inline at the point it was fixed, but listed here as a map:

1. **Fire-and-forget GitHub API calls hid a real failure.** The first
   version of `postCommitStatus()` never checked the response — a failed
   POST looked identical to success. Fixed by checking `res.ok` and
   surfacing the real error.
2. **Missing `User-Agent` header.** GitHub's API 403s on any request
   without one (`curl` sets one by default, `fetch()` doesn't) — easy to
   miss since a manual curl test of "the same" call works fine.
3. **Checking `latest_stage.status` alone reports "ready" the instant a
   build is merely queued.** A Cloudflare deployment moves through several
   stages (queued → initialize → clone_repo → build → deploy), and
   `latest_stage` reports whichever stage is *current* along with *that
   stage's own* status — an early stage succeeding isn't the deployment
   succeeding. Only `latest_stage.name === 'deploy' && status ===
   'success'` means it's actually live.
4. **Excluding a single "baseline" deployment ID isn't enough.** With
   several older, already-successful deployments for the same branch
   sitting around (normal after any real amount of editing), excluding
   only the *one* baseline ID lets the lookup fall through to the
   *next*-oldest one and misreport it as "the new build" — regardless of
   how long the real new build actually takes. Fixed by comparing
   `created_on` **timestamps** (both from Cloudflare's own API, no client
   clock involved) and requiring strictly newer, not just "not that one
   specific ID."
5. **Overlapping poll loops from rapid saves.** Every Save started an
   independent poll loop with no way to cancel an earlier one — saving
   again before an earlier build finished left both loops writing to the
   same UI element, so whichever one finished *last* won, regardless of
   which Save it was actually about. Fixed with a generation counter: each
   loop is stamped at creation and checks it's still current before ever
   showing a result.
6. **Baseline captured too late — a real race, not just theoretical.**
   Earlier versions captured the "baseline" deployment (the one every poll
   needs to see something strictly newer than) inside the `postSave`
   handler. `postSave` only fires *after* Decap has already created the
   branch, committed the file, and opened the PR — exactly what triggers
   Cloudflare's build. On a slow-enough build there's always been time for
   the baseline fetch to run before Cloudflare's own deployment record
   appeared, so this never surfaced in testing. On a project whose build
   finished in ~23 seconds, the baseline fetch lost the race and captured
   the *new* deployment as its own baseline — so every subsequent poll
   asked for something "strictly newer than baseline" that would never
   exist, and the UI reported "Still building… check GitHub directly"
   after the full 2-minute timeout even though the real build had already
   succeeded in well under a minute. Fixed by capturing the baseline in a
   `preSave` handler instead — it fires before Decap does anything, so no
   branch/PR/build can possibly exist yet when it runs, regardless of how
   fast the actual build turns out to be. (One subtlety worth recording:
   `preSave`'s return value, if not `undefined`, gets grafted into the
   entry's own `data` field by Decap's own event-processing code — a
   `preSave` handler that only wants to observe the entry, not modify it,
   must return nothing at all. Confirmed directly against decap-cms-core's
   bundled source rather than assumed, after nearly shipping a version
   that returned the whole entry and would have corrupted every save.)

Also worth knowing, not a bug in this code but a real characteristic of
the platform: **even after `deploy/success`, the branch alias URL can take
another ~10-30s to fully propagate across Cloudflare's edge network** —
this is alias-routing propagation, not HTTP caching (confirmed: the served
HTML has `Cache-Control: no-store`-equivalent freshness directives, no
`cf-cache-status` header at all). The "ready" banner says so explicitly
rather than implying instant visibility.

## Preview URL choice

Always uses the **stable branch-alias URL** (`deployment.aliases[0]`)
rather than the per-commit hash URL. The per-commit one is frozen forever
at whatever content existed the moment it was built — a second edit's
change won't show there even though the deployment API says "success",
which looks exactly like a data bug until you realize you're looking at an
old, immutable URL. The alias always redirects to the latest deployment
for that branch, so one link stays correct across every subsequent Save.
