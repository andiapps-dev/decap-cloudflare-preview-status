// Cloudflare Pages Functions middleware for everything under /admin/*.
//
// Why this exists: /admin worked on every deployment URL for this project
// -- production, every per-commit hash URL, every branch-alias preview URL
// -- which is confusing (an editor landing on a stale per-commit preview's
// /admin could easily mistake it for the real thing) and also pointless:
// GitHub OAuth login only works from the production URL anyway (classic
// OAuth Apps accept exactly one registered callback URL), so /admin on any
// other hostname was reachable but never actually functional for login.
//
// This blocks /admin/* specifically -- Cloudflare Pages Functions
// middleware is scoped to its own directory, so this does NOT cover
// /auth, /callback, /preview-url, or /github-webhook (those are separate
// top-level routes). /auth and /callback fail safely on their own even
// without this (GitHub rejects the OAuth redirect at its end, since only
// the production callback URL is registered) -- this middleware is purely
// about giving /admin itself a clean 404 instead of a half-working page
// on the wrong hostname.
//
// Reusable as-is for any project -- the only project-specific bit is the
// PRODUCTION_HOSTNAME env var itself.
//
// Needs PRODUCTION_HOSTNAME as an env var (Settings -> Environment
// variables, Production AND Preview -- this must be set on Preview too,
// specifically so it can block /admin on preview URLs at all; if it were
// Production-only, this middleware wouldn't even run on preview
// deployments in the first place, defeating the point).

export async function onRequest(context) {
  const { request, env, next } = context;
  const hostname = new URL(request.url).hostname;

  if (!env.PRODUCTION_HOSTNAME) {
    // Fail open rather than locking out /admin entirely if this is
    // misconfigured -- a missing env var shouldn't turn into a self-
    // inflicted outage of the one interface that would let someone fix it.
    return next();
  }

  if (hostname !== env.PRODUCTION_HOSTNAME) {
    return new Response(
      `/admin is only available at https://${env.PRODUCTION_HOSTNAME} -- not on preview or per-commit URLs.`,
      { status: 404 }
    );
  }

  return next();
}
