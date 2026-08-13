# decap-preview-cleanup (Worker)

Deletes Cloudflare Pages deployments that have been superseded, so they
don't pile up forever — every Decap editorial-workflow Save creates a new
**preview** deployment, and every merge to `main` creates a new
**production** one, and Cloudflare never deletes any of them on its own.
This Worker runs weekly and cleans up both:

- **Preview**: for each branch that still exists on GitHub, keeps only
  its single newest deployment and deletes older, superseded ones (a
  branch with several Saves otherwise accumulates a deployment per Save,
  forever). For a branch that's gone entirely (Decap deletes the branch +
  closes the PR on both Delete and Publish), deletes **every** deployment
  for it — there's nothing left to preview.
- **Production**: keeps only the single newest deployment, deletes
  everything older. Cloudflare always serves live traffic from the newest
  one via the stable domain alias, so older ones are pure history — not
  anything currently reachable. (Deleting them does give up Cloudflare's
  own one-click "rollback to a previous deployment" from the dashboard;
  a revert is still just a normal `git revert` + push away.)

Both respect the same 24-hour grace period on anything too new, with the
same manual `ignoreGracePeriod` override described below applying to both.

This is a **Worker**, not part of the Pages project's `functions/` — Pages
has no scheduled-execution mechanism of its own; Cron Triggers are a
Workers-only feature. Deployed and updated independently via `wrangler
deploy`, not synced by the main package's `postinstall` script.

## Deploy

```bash
cd cleanup-worker
npx wrangler deploy
```

(`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` env vars, or `wrangler
login`, needed to authenticate — same as any wrangler deploy.)

## Secrets (once, per project this is deployed for)

```bash
wrangler secret put GITHUB_TOKEN            # PAT scoped to ONLY "Contents: Read"
wrangler secret put GITHUB_REPO             # "<owner>/<repo>"
wrangler secret put CF_API_TOKEN            # scoped to "Cloudflare Pages: Edit" (needs delete, not just read)
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_PAGES_PROJECT_NAME
wrangler secret put MANUAL_TRIGGER_TOKEN    # random secret, e.g. `openssl rand -hex 32`
```

## Testing without waiting a week

```bash
curl "https://decap-preview-cleanup.<your-subdomain>.workers.dev/?token=<MANUAL_TRIGGER_TOKEN>"
```

Returns JSON: what was checked, what was deleted (each entry tagged
`env: 'preview'` or `env: 'production'`, plus `branch` for preview
entries), and why everything else was skipped (latest in its group,
keeping / within grace period / production branch, refusing to touch / no
branch metadata / delete request failed). Same code path the weekly cron
runs — this is a real trigger, not a dry run, so it will actually delete
anything that qualifies.

The scheduled run's own output is only visible in the dashboard's Worker
Logs (or `wrangler tail` while it's running) — cron triggers have no HTTP
response to return results in.

## Cleaning up right now, ignoring the grace period

For a deliberate one-off "yes, clean up everything eligible right now, I
don't want to wait 24 hours" run (e.g. right after a heavy testing
session):

```bash
curl "https://decap-preview-cleanup.<your-subdomain>.workers.dev/?token=<MANUAL_TRIGGER_TOKEN>&ignoreGracePeriod=true"
```

Only reachable via this manual trigger — the weekly cron always keeps the
24-hour grace period, this flag has no effect on it.
