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
    return new Date().toLocaleTimeString([], { hour12: false });
  }

  // Full-width bar fixed to the very top of the viewport — Decap's own
  // React app doesn't expose a stable hook for inserting directly next to
  // its Save button (fragile to target precisely, could break on any
  // Decap update), so this achieves "prominent, not tucked in a corner"
  // by sitting above everything instead, always the first thing visible.
  function showNotice(message, url, note) {
    const existing = document.getElementById('preview-status-notice');
    if (existing) existing.remove();

    const notice = document.createElement('div');
    notice.id = 'preview-status-notice';
    notice.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;' +
      'background:#1a1a1a;color:#fff;padding:12px 20px;' +
      'font:14px -apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
      'display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;';

    const text = document.createElement('span');
    text.textContent = `[${timestamp()}] ${message}`;
    notice.appendChild(text);

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

    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;';
    close.onclick = () => notice.remove();
    notice.appendChild(close);

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

  if (window.CMS && typeof window.CMS.registerEventListener === 'function') {
    window.CMS.registerEventListener({
      name: 'postSave',
      handler: async ({ entry }) => {
        const branch = branchForEntry(entry);
        if (!branch) return;
        const myGeneration = ++generation;
        const startedAt = timestamp();
        showNotice('Building deploy preview…', null, `Started ${startedAt} — typically takes 1-2 min total.`);
        // Capture whatever deployment currently exists for this branch
        // *before* waiting for a new one — this is the baseline every
        // subsequent poll excludes, so "ready" only fires for a build
        // that's genuinely new relative to the moment this Save happened.
        let baselineId = null;
        try {
          const baseline = await fetchDeployment(branch);
          baselineId = baseline.id || null;
        } catch (e) {
          // No baseline (e.g. first-ever build for this branch, or a
          // transient fetch error) — fine, exclude_id=null just means
          // "accept whatever's newest", same as before this feature.
        }
        if (myGeneration !== generation) return; // another Save happened while awaiting the baseline
        pollUntilReady(branch, baselineId, myGeneration, 0, startedAt);
      },
    });
  }
})();
