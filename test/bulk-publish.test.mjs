// Layer 1: pure offline logic tests for functions/admin/bulk-publish.js.
//
// Mocks global fetch entirely -- no network, no real GitHub/Cloudflare
// account needed, runs anywhere in milliseconds. This verifies the
// ORCHESTRATION LOGIC only: call ordering, which step aborts on which
// response, exact request bodies/URLs, exact response shapes. It cannot
// prove GitHub's real merge/conflict/PR-auto-detection behavior or
// Cloudflare's real preview-build-suspension behavior actually work the
// way this code assumes -- that's what the Layer 2 sandbox test (see the
// package README) is for. Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../src/functions/admin/bulk-publish-api.js';

const BASE_ENV = {
  GITHUB_REPO: 'test-owner/test-repo',
  CF_PAGES_EDIT_TOKEN: 'fake-cf-token',
  CF_ACCOUNT_ID: 'fake-account-id',
  CF_PAGES_PROJECT_NAME: 'fake-project',
};

function req(body, token) {
  const headers = new Map();
  headers.set('authorization', token ? `Bearer ${token}` : '');
  return {
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    json: async () => body,
  };
}

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A tiny router: each test supplies a list of [matcher, response] pairs,
// consumed in order (asserts calls happen in the expected sequence,
// which is itself part of what this orchestration needs to get right --
// e.g. never creating a scratch branch before re-validating the
// selection). `calls` records every request made for post-hoc assertions
// on exact URLs/bodies.
function mockFetch(steps) {
  const calls = [];
  let i = 0;
  return {
    calls,
    fn: async (url, init) => {
      calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
      if (i >= steps.length) {
        throw new Error(`unexpected extra fetch call: ${init?.method || 'GET'} ${url}`);
      }
      const [expectedUrlFragment, response] = steps[i];
      i++;
      assert.ok(url.includes(expectedUrlFragment), `expected call ${i} to include '${expectedUrlFragment}', got '${url}'`);
      return typeof response === 'function' ? response() : response;
    },
  };
}

function cfProject(previewDeploymentSetting) {
  return jsonRes({
    success: true,
    result: {
      source: { type: 'github', config: { preview_deployment_setting: previewDeploymentSetting } },
    },
  });
}

// --- onRequestGet ---

test('onRequestGet: 500 when env vars missing', async () => {
  const res = await onRequestGet({ request: req(), env: {} });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /not configured/);
});

test('onRequestGet: reports bulkModeOn true/false from Cloudflare project state', async () => {
  const mock = mockFetch([['pages/projects/fake-project', cfProject('none')]]);
  globalThis.fetch = mock.fn;
  const res = await onRequestGet({ request: req(), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.bulkModeOn, true);
  assert.equal(body.prs.length, 0); // no token supplied -> no PR list attempted
  assert.equal(mock.calls.length, 1); // never called the pulls API without a token
});

test('onRequestGet: with a token, lists and filters to cms/* PRs only', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('all')],
    [
      'repos/test-owner/test-repo/pulls',
      jsonRes([
        { number: 1, title: 'A', head: { ref: 'cms/posts/a' }, updated_at: 't1', user: { login: 'alice' }, html_url: 'u1' },
        { number: 2, title: 'B', head: { ref: 'unrelated-branch' }, updated_at: 't2', user: { login: 'bob' }, html_url: 'u2' },
        { number: 3, title: 'C', head: { ref: 'cms/settings/site' }, updated_at: 't3', user: { login: 'alice' }, html_url: 'u3' },
      ]),
    ],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestGet({ request: req(null, 'my-token'), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.bulkModeOn, false);
  assert.equal(body.prs.length, 2);
  assert.deepEqual(body.prs.map((p) => p.branch), ['cms/posts/a', 'cms/settings/site']);
});

// --- onRequestPost: enable / disable-and-publish (empty) ---

test('onRequestPost enable: PATCHes preview_deployment_setting to none', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('all')],
    [
      'pages/projects/fake-project',
      (() => {
        return jsonRes({ success: true, result: {} });
      })(),
    ],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({ request: req({ action: 'enable' }), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.bulkModeOn, true);
  assert.equal(mock.calls[1].method, 'PATCH');
  assert.equal(mock.calls[1].body.source.config.preview_deployment_setting, 'none');
});

test('onRequestPost disable-and-publish with empty branches: just restores, no GitHub calls at all', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('none')],
    ['pages/projects/fake-project', jsonRes({ success: true, result: {} })],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({
    request: req({ action: 'disable-and-publish', branches: [] }, 'my-token'),
    env: BASE_ENV,
  });
  const body = await res.json();
  assert.equal(body.bulkModeOn, false);
  assert.deepEqual(body.published, []);
  assert.equal(mock.calls.length, 2); // never touched GitHub's API at all
});

test('onRequestPost disable-and-publish with empty branches: works with NO token at all', async () => {
  // Regression test for a real bug caught in sandbox testing: this path
  // never touches GitHub, so it must not require a token -- requiring
  // one here was worse than pointless, since it would never actually be
  // validated against anything either.
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('none')],
    ['pages/projects/fake-project', jsonRes({ success: true, result: {} })],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({
    request: req({ action: 'disable-and-publish', branches: [] }), // no token
    env: BASE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.bulkModeOn, false);
});

test('onRequestPost disable-and-publish: 401 when no token supplied', async () => {
  const res = await onRequestPost({
    request: req({ action: 'disable-and-publish', branches: ['cms/a'] }),
    env: BASE_ENV,
  });
  assert.equal(res.status, 401);
});

test('onRequestPost: unknown action -> 400', async () => {
  const res = await onRequestPost({ request: req({ action: 'nonsense' }), env: BASE_ENV });
  assert.equal(res.status, 400);
});

test('onRequestPost: malformed JSON body -> 400', async () => {
  const badReq = { headers: { get: () => null }, json: async () => { throw new Error('bad json'); } };
  const res = await onRequestPost({ request: badReq, env: BASE_ENV });
  assert.equal(res.status, 400);
});

// --- onRequestPost disable-and-publish: the full orchestration ---

test('onRequestPost disable-and-publish: happy path, two branches, correct call order and bodies', async () => {
  const mock = mockFetch([
    // Step 0: re-validate selection against a fresh open-PR list
    [
      'repos/test-owner/test-repo/pulls',
      jsonRes([
        { number: 1, title: 'A', head: { ref: 'cms/posts/a' }, updated_at: 't1', user: { login: 'alice' }, html_url: 'u1' },
        { number: 2, title: 'B', head: { ref: 'cms/posts/b' }, updated_at: 't2', user: { login: 'bob' }, html_url: 'u2' },
      ]),
    ],
    // Read main's tip
    ['git/ref/heads/main', jsonRes({ object: { sha: 'main-sha' } })],
    // Create scratch branch
    ['git/refs', jsonRes({ ref: 'refs/heads/bulk-publish-xyz' })],
    // Merge branch a into scratch
    ['repos/test-owner/test-repo/merges', jsonRes({ sha: 'merge-a-sha' })],
    // Merge branch b into scratch
    ['repos/test-owner/test-repo/merges', jsonRes({ sha: 'merge-b-sha' })],
    // Final merge: scratch into main
    ['repos/test-owner/test-repo/merges', jsonRes({ sha: 'final-sha' })],
    // Cleanup: delete scratch branch
    ['git/refs/heads/bulk-publish', jsonRes({}, 204)],
    // Cleanup: delete branch a
    ['git/refs/heads/cms/posts/a', jsonRes({}, 204)],
    // Cleanup: delete branch b
    ['git/refs/heads/cms/posts/b', jsonRes({}, 204)],
    // Restore preview builds
    ['pages/projects/fake-project', cfProject('none')],
    ['pages/projects/fake-project', jsonRes({ success: true, result: {} })],
  ]);
  globalThis.fetch = mock.fn;

  const res = await onRequestPost({
    request: req({ action: 'disable-and-publish', branches: ['cms/posts/a', 'cms/posts/b'] }, 'my-token'),
    env: BASE_ENV,
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.published, ['cms/posts/a', 'cms/posts/b']);
  assert.equal(body.mainMergeSha, 'final-sha');
  assert.equal(body.bulkModeOn, false);
  assert.equal(body.warnings.length, 0);

  // The two per-branch merges and the final merge all target the right
  // base/head -- this is the crux of "exactly one production build":
  // the first two merges must go into the scratch branch (never main),
  // only the last merge targets main.
  const merges = mock.calls.filter((c) => c.url.includes('/merges'));
  assert.equal(merges.length, 3);
  assert.notEqual(merges[0].body.base, 'main'); // scratch branch name is timestamped; just confirm it's not main
  assert.equal(merges[0].body.head, 'cms/posts/a');
  assert.notEqual(merges[1].body.base, 'main');
  assert.equal(merges[1].body.head, 'cms/posts/b');
  assert.equal(merges[2].body.base, 'main'); // only the LAST merge touches main
});

test('onRequestPost disable-and-publish: branch no longer open -> 409 before creating anything', async () => {
  const mock = mockFetch([
    [
      'repos/test-owner/test-repo/pulls',
      jsonRes([{ number: 1, title: 'A', head: { ref: 'cms/posts/a' }, updated_at: 't1', user: { login: 'alice' }, html_url: 'u1' }]),
    ],
  ]);
  globalThis.fetch = mock.fn;

  const res = await onRequestPost({
    request: req({ action: 'disable-and-publish', branches: ['cms/posts/a', 'cms/posts/gone'] }, 'my-token'),
    env: BASE_ENV,
  });
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.match(body.error, /cms\/posts\/gone.*no longer an open/);
  assert.equal(mock.calls.length, 1); // never even read main's ref -- aborted before creating anything
});

test('onRequestPost disable-and-publish: merge conflict mid-batch aborts, leaves scratch branch, does not restore preview builds', async () => {
  const mock = mockFetch([
    [
      'repos/test-owner/test-repo/pulls',
      jsonRes([
        { number: 1, title: 'A', head: { ref: 'cms/posts/a' }, updated_at: 't1', user: { login: 'alice' }, html_url: 'u1' },
        { number: 2, title: 'B', head: { ref: 'cms/posts/b' }, updated_at: 't2', user: { login: 'bob' }, html_url: 'u2' },
      ]),
    ],
    ['git/ref/heads/main', jsonRes({ object: { sha: 'main-sha' } })],
    ['git/refs', jsonRes({ ref: 'refs/heads/bulk-publish-xyz' })],
    ['repos/test-owner/test-repo/merges', jsonRes({ sha: 'merge-a-sha' })], // a merges cleanly
    ['repos/test-owner/test-repo/merges', jsonRes({ message: 'Merge conflict' }, 409)], // b conflicts
  ]);
  globalThis.fetch = mock.fn;

  const res = await onRequestPost({
    request: req({ action: 'disable-and-publish', branches: ['cms/posts/a', 'cms/posts/b'] }, 'my-token'),
    env: BASE_ENV,
  });
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.conflictedBranch, 'cms/posts/b');
  assert.deepEqual(body.alreadyMerged, ['cms/posts/a']);
  assert.ok(body.scratchBranch);
  // Exactly the calls up through the failed merge -- no delete calls, no
  // final main-merge, no Cloudflare restore call. Bulk mode stays ON.
  assert.equal(mock.calls.length, 5);
});
