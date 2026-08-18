// External script (not inline) — an earlier inline <script> block in this
// same file mysteriously never reached the browser despite the server
// confirmed serving it (never root-caused). An external file loaded via
// <script src="..."> is far easier to verify directly (Network tab shows
// a plain 200/404), so that's the pattern used here.
//
// Decap's own native "Check for Preview" UI doesn't surface a live
// building-vs-ready state in any visible way (confirmed directly: no
// indicator shows at all while a build is in progress, even though a real
// `pending` commit status is posted correctly — see functions/github-webhook.js).
// So instead of relying on that, this polls the same Cloudflare-backed
// lookup functions/preview-url.js already exposes, and shows a small,
// dismissible, non-disruptive notice once the build for this Save
// actually finishes — no forced reload, no guessing.

(function () {
  function branchForEntry(entry) {
    // Mirrors Decap's own editorial-workflow branch naming
    // (cms/<collection>/<slug>) by reading it off the entry's file path —
    // works the same for folder collections (src/content/posts/my-post.json)
    // and file collections (src/content/settings/site.json) since both
    // reduce to "second-to-last path segment" + "filename without
    // extension".
    const path = entry.get('path');
    if (!path) return null;
    const parts = path.split('/');
    if (parts.length < 2) return null;
    const collection = parts[parts.length - 2];
    const slug = parts[parts.length - 1].replace(/\.[^.]+$/, '');
    return `cms/${collection}/${slug}`;
  }

  function timestamp() {
    return new Date().toLocaleTimeString([], { hour12: true });
  }

  // Fixed box, bottom-left corner -- originally a full-width bar pinned
  // to the very top of the viewport, but that covered up whatever Decap
  // itself renders up there (its own header/toolbar), a real reported
  // problem. Bottom-left specifically so it doesn't collide with the
  // GitHub/Cloudflare service-status widget, which lives bottom-right
  // (see the bottom of this file) -- the two are independent, unrelated
  // pieces of status and shouldn't visually compete for the same corner.
  // Stacked/multiline (flex-direction:column) rather than one long
  // horizontal row, so a note+link don't force the box wider than it
  // needs to be.
  function showNotice(message, url, note) {
    const existing = document.getElementById('preview-status-notice');
    if (existing) existing.remove();

    const notice = document.createElement('div');
    notice.id = 'preview-status-notice';
    notice.style.cssText =
      'position:fixed;bottom:12px;left:12px;z-index:9999;max-width:340px;' +
      'background:#1a1a1a;color:#fff;padding:12px 16px;border-radius:6px;' +
      'font:14px -apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
      'display:flex;flex-direction:column;align-items:flex-start;gap:6px;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;';

    const text = document.createElement('span');
    text.textContent = `[${timestamp()}] ${message}`;
    header.appendChild(text);

    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;flex-shrink:0;';
    close.onclick = () => notice.remove();
    header.appendChild(close);

    notice.appendChild(header);

    if (note) {
      const noteEl = document.createElement('span');
      noteEl.textContent = note;
      noteEl.style.cssText = 'color:#aaa;font-size:12px;';
      notice.appendChild(noteEl);
    }

    if (url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open →';
      link.style.cssText = 'color:#4fc3f7;font-weight:600;text-decoration:underline;white-space:nowrap;';
      notice.appendChild(link);
    }

    document.body.appendChild(notice);
    return notice;
  }

  async function fetchDeployment(branch, afterId) {
    const url = afterId
      ? `/preview-url?branch=${encodeURIComponent(branch)}&after_id=${afterId}`
      : `/preview-url?branch=${encodeURIComponent(branch)}`;
    // Belt-and-suspenders alongside the function's own Cache-Control:
    // no-store — this is polled data, never safe to serve from any cache.
    const res = await fetch(url, { cache: 'no-store' });
    return res.json();
  }

  // Every Save starts its own independent poll loop that can run for up
  // to 2 minutes. Without this, saving again before an earlier loop
  // finishes leaves BOTH loops running — and since they all write to the
  // same notice element, whichever one happens to finish last simply
  // overwrites it, regardless of which Save it was actually about. In
  // testing this produced exactly the confusing symptom of a "ready"
  // notice popping up suspiciously fast after a new Save: it was really
  // an earlier, unrelated loop finishing up and stomping over the new
  // "Building…" message. Each new Save bumps this counter and stamps its
  // own loop with the value at the time; a loop that finds its stamp no
  // longer matches the current generation silently abandons its result
  // instead of showing it — it's been superseded by a newer Save.
  let generation = 0;

  async function pollUntilReady(branch, baselineId, myGeneration, attempt, startedAt) {
    attempt = attempt || 0;
    if (myGeneration !== generation) return; // superseded — abandon quietly
    try {
      // Passing the pre-Save baseline id as after_id is what makes this
      // precise: the endpoint only accepts a deployment strictly NEWER
      // than the baseline (by Cloudflare's own timestamps), not merely
      // "not literally that one id" — with several older deployments
      // typically sitting around from prior saves, the earlier
      // single-id-exclusion version could fall through to one of THOSE
      // and report it as ready, regardless of how long the real new
      // build actually took.
      const data = await fetchDeployment(branch, baselineId);
      if (myGeneration !== generation) return; // superseded while awaiting
      if (data.status === 'success' && data.url) {
        // The build itself is genuinely done at this point (verified
        // directly against Cloudflare's own build logs), but the branch
        // alias URL can take up to another ~20-30s to fully propagate
        // across Cloudflare's edge network afterward — a real, separate
        // step, not something our code controls. Said plainly here so a
        // couple of refreshes right after this isn't mistaken for a bug.
        showNotice(
          '✅ Build ready:',
          data.url,
          'Content may take another ~1-2 min to fully appear everywhere (CDN propagation) — a refresh or two is normal.'
        );
        return;
      }
      if (data.status === 'failure') {
        showNotice('❌ Preview build failed — check GitHub for details.', null);
        return;
      }
      // 'not_found' means Cloudflare hasn't created a record for the new
      // build yet — the exact case that used to report "ready" instantly
      // by falling back to the baseline's already-successful status.
    } catch (e) {
      // fall through to retry below
    }
    // Cloudflare builds in this project have taken up to ~40s in testing;
    // poll every 5s for up to 2 minutes before giving up.
    if (attempt < 24) {
      showNotice('Building deploy preview…', null, `Started ${startedAt} — typically takes 1-2 min total.`);
      setTimeout(() => pollUntilReady(branch, baselineId, myGeneration, attempt + 1, startedAt), 5000);
    } else if (myGeneration === generation) {
      showNotice('Still building after 2 minutes — check GitHub directly.', null);
    }
  }

  // Baselines captured in `preSave` (see below), keyed by branch, and
  // consumed once by the matching `postSave` handler.
  //
  // Bug found on a fast-building project (real build finished in ~23s):
  // capturing the baseline in `postSave` — as an earlier version of this
  // file did — is a genuine race, not just theoretically. `postSave` only
  // fires *after* Decap has already created the branch, committed the
  // file, and opened the PR — all of which is what triggers Cloudflare's
  // build in the first place. On a slow-enough build there's always been
  // time for the `postSave` baseline fetch to run before Cloudflare's own
  // deployment record appears, so this never surfaced. On a fast build, the
  // baseline fetch can lose that race and capture the *new* deployment as
  // its own baseline — after which every poll asks for something "strictly
  // newer than baseline" that will never exist, and the whole 2-minute
  // poll silently burns down to "Still building… check GitHub directly"
  // even though the real build already succeeded, often in seconds.
  // `preSave` fires before Decap does anything — the branch/commit/PR (and
  // therefore any Cloudflare build) cannot possibly exist yet when this
  // runs, so capturing the baseline here is race-proof regardless of how
  // fast the build turns out to be.
  const pendingBaselines = new Map();

  if (window.CMS && typeof window.CMS.registerEventListener === 'function') {
    window.CMS.registerEventListener({
      name: 'preSave',
      handler: async ({ entry }) => {
        const branch = branchForEntry(entry);
        if (!branch) return;
        let baselineId = null;
        try {
          const baseline = await fetchDeployment(branch);
          baselineId = baseline.id || null;
        } catch (e) {
          // No baseline (e.g. first-ever build for this branch, or a
          // transient fetch error) — fine, exclude_id=null just means
          // "accept whatever's newest", same as before this feature.
        }
        pendingBaselines.set(branch, baselineId);
        // Deliberately returns undefined (no return statement at all) —
        // NOT `entry`. Decap's own preSave handling
        // (invokeEventWithEntry -> Er in decap-cms-core) treats a
        // preSave handler's return value, if not `undefined`, as the
        // entry's new `data` field via `entry.set("data", returnValue)` —
        // confirmed directly against decap-cms-core's bundled source, not
        // assumed. Returning the whole `entry` object here (an earlier
        // draft of this fix did exactly that) would have nested the
        // entire entry inside its own `data` field on every single Save,
        // silently corrupting saved content. This handler only observes
        // the entry for a side effect (capturing the baseline) and must
        // never modify it, so `undefined` — "leave the entry exactly as
        // it is" — is the only correct return value.
      },
    });

    window.CMS.registerEventListener({
      name: 'postSave',
      handler: async ({ entry }) => {
        const branch = branchForEntry(entry);
        if (!branch) return;
        const myGeneration = ++generation;
        const startedAt = timestamp();
        showNotice('Building deploy preview…', null, `Started ${startedAt} — typically takes 1-2 min total.`);
        // Consume the baseline preSave captured for this exact branch. If
        // for some reason none exists (e.g. preSave didn't fire — older
        // Decap version, or this save raced a page load), fall back to
        // null: "accept whatever's newest" is a safe degradation, just
        // without the same race protection.
        const baselineId = pendingBaselines.has(branch) ? pendingBaselines.get(branch) : null;
        pendingBaselines.delete(branch);
        pollUntilReady(branch, baselineId, myGeneration, 0, startedAt);
      },
    });
  }

  // Bulk Publish (functions/admin/bulk-publish-api.js) can suspend preview
  // builds project-wide while "Bulk Mode" is on -- if an editor enables
  // it and never comes back to publish/disable it, every future Save
  // from ANYONE, not just that editor, silently stops getting preview
  // builds until someone notices. This is a cheap, separate check (not
  // tied to any Save) so that risk is visible to every editor on every
  // /admin page load, not just whoever happens to visit the bulk-publish
  // page itself. A failure here (e.g. the endpoint 500s because
  // CF_PAGES_EDIT_TOKEN isn't configured yet) is silently ignored --
  // this is a convenience banner, not a load-bearing check, and
  // shouldn't itself become a source of noisy errors on every admin page
  // load for a project that hasn't set up Bulk Publish's env vars at all.
  fetch('/admin/bulk-publish-api', { cache: 'no-store' })
    .then((res) => res.json())
    .then((data) => {
      if (data.bulkModeOn) {
        showNotice(
          '⚠️ Bulk Mode is ON',
          null,
          'No Save — this one or anyone else’s — will get a preview build until it’s turned off from /admin/bulk-publish.'
        );
      }
    })
    .catch(() => {});

  // Small, persistent GitHub/Cloudflare status indicator, bottom-right —
  // deliberately separate from showNotice()'s banners above (those are
  // transient, dismissible, about THIS admin's own build status; this is
  // a standing "are the two services everything here depends on
  // currently healthy" check, useful on its own even with nothing being
  // saved right now). Both status pages are the real, public Atlassian
  // Statuspage JSON APIs GitHub/Cloudflare themselves publish (confirmed
  // directly: both send Access-Control-Allow-Origin: *, meaning they're
  // deliberately meant to be fetched client-side like this, not just
  // viewed in a browser tab) — no token, no server-side Function, no new
  // secret of any kind needed for this.
  const STATUS_ENDPOINTS = [
    { label: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json' },
    { label: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
  ];
  const STATUS_CHECK_INTERVAL_MS = 15 * 60 * 1000;

  function statusIcon(indicator) {
    // Atlassian Statuspage's own indicator values, every product using
    // it (GitHub, Cloudflare, many others) reports one of exactly these
    // four: https://status.io / statuspage.io's documented set.
    if (indicator === 'none') return '✅';
    if (indicator === 'minor') return '⚠️';
    if (indicator === 'major' || indicator === 'critical') return '❌';
    return '❔'; // unrecognized value — degrade visibly rather than guess
  }

  async function checkServiceStatus() {
    const results = await Promise.all(
      STATUS_ENDPOINTS.map(async ({ label, url }) => {
        try {
          const res = await fetch(url, { cache: 'no-store' });
          const data = await res.json();
          return { label, icon: statusIcon(data.status.indicator), text: data.status.description };
        } catch (e) {
          // A failed check is NOT the same as a confirmed outage — show
          // a distinct "couldn't check" state rather than a false-clean
          // green or an alarmist red for what might just be this
          // browser's own network hiccup.
          return { label, icon: '❔', text: 'Could not check' };
        }
      })
    );

    let widget = document.getElementById('service-status-widget');
    if (!widget) {
      widget = document.createElement('div');
      widget.id = 'service-status-widget';
      widget.style.cssText =
        'position:fixed;bottom:12px;right:12px;z-index:9998;' +
        'background:#1a1a1a;color:#fff;padding:8px 12px;border-radius:6px;' +
        'font:12px -apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
        'display:flex;flex-direction:column;gap:4px;';
      document.body.appendChild(widget);
    }
    widget.innerHTML = '';
    results.forEach(({ label, icon, text }) => {
      const row = document.createElement('div');
      row.textContent = `${icon} ${label}: ${text}`;
      row.title = `${label} status, checked ${timestamp()}`;
      widget.appendChild(row);
    });
  }

  checkServiceStatus();
  setInterval(checkServiceStatus, STATUS_CHECK_INTERVAL_MS);
})();
