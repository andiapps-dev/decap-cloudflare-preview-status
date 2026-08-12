# decap-preview-cleanup (Worker)

Deletes orphaned Cloudflare Pages **preview** deployments — every Decap
editorial-workflow Save creates one, and while Decap cleans up the GitHub
side nicely on its own (deletes the branch, closes the PR, both on Delete
and on Publish), Cloudflare never deletes the deployment itself. This
Worker runs weekly, compares current GitHub branches against current
Cloudflare preview deployments, and deletes anything whose branch is gone
— with a 24-hour grace period on anything too new, and production
deployments excluded by construction (only ever queries `env=preview`,
plus an explicit `branch === 'main'` refusal as belt-and-suspenders).

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

Returns JSON: what was checked, what was deleted, and why everything else
was skipped (branch still exists / within grace period / production
branch / no branch metadata). Same code path the weekly cron runs — this
is a real trigger, not a dry run, so it will actually delete anything that
qualifies.

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
