# decap-cloudflare-preview-status

Makes Decap CMS's `editorial_workflow` + Cloudflare Pages show accurate,
real-time build status to editors — both Decap's own native "Check for
Preview" UI, and a prominent in-admin banner.

Also includes [`cleanup-worker/`](./cleanup-worker), a small, separately
deployed Cloudflare Worker (Cron Trigger, not part of the Pages project)
that periodically deletes orphaned preview deployments — every Save
creates one, and Cloudflare never cleans them up on its own even after
Decap deletes the branch.

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
