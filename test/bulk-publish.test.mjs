// Layer 1: pure offline logic tests for functions/admin/bulk-publish-api.js.
//
// Mocks global fetch entirely -- no network, no real GitHub/Cloudflare
// account needed, runs anywhere in milliseconds. This verifies the
// ORCHESTRATION LOGIC only: call ordering, which step aborts on which
// response, exact request bodies/URLs, exact response shapes. It cannot
// prove GitHub's real merge/conflict/PR-auto-detection behavior or
// Cloudflare's real preview-build-suspension/narrowing behavior actually
// work the way this code assumes -- that's what the sandbox test (see
// the package README) is for. Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../src/functions/admin/bulk-publish-api.js';

const BASE_ENV = {
  GITHUB_REPO: 'test-owner/test-repo',
  CF_PAGES_EDIT_TOKEN: 'fake-cf-token',
  CF_ACCOUNT_ID: 'fake-account-id',
  CF_PAGES_PROJECT_NAME: 'fake-project',
};

function req(body, token, url) {
  const headers = new Map();
  headers.set('authorization', token ? `Bearer ${token}` : '');
  return {
    url: url || 'https://example.pages.dev/admin/bulk-publish-api',
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
// which is itself part of what this orchestration needs to get right).
// `calls` records every request made for post-hoc assertions on exact
// URLs/bodies.
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

function cfProject(setting, includes) {
  const config = { preview_deployment_setting: setting };
  if (includes !== undefined) config.preview_branch_includes = includes;
  return jsonRes({ success: true, result: { source: { type: 'github', config } } });
}

function pullsPage(items) {
  return jsonRes(items);
}

const PR_A = { number: 1, title: 'A', head: { ref: 'cms/posts/a' }, updated_at: 't1', user: { login: 'alice' }, html_url: 'u1' };
const PR_B = { number: 2, title: 'B', head: { ref: 'cms/posts/b' }, updated_at: 't2', user: { login: 'bob' }, html_url: 'u2' };

// --- onRequestGet ---

test('onRequestGet: 500 when env vars missing', async () => {
  const res = await onRequestGet({ request: req(), env: {} });
  assert.equal(res.status, 500);
});

test('onRequestGet: bulk mode off (setting=all), no scratch', async () => {
  const mock = mockFetch([['pages/projects/fake-project', cfProject('all')]]);
  globalThis.fetch = mock.fn;
  const res = await onRequestGet({ request: req(), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.bulkModeOn, false);
  assert.equal(body.scratch, null);
});

test('onRequestGet: bulk mode on (setting=none), no scratch', async () => {
  const mock = mockFetch([['pages/projects/fake-project', cfProject('none')]]);
  globalThis.fetch = mock.fn;
  const res = await onRequestGet({ request: req(), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.bulkModeOn, true);
  assert.equal(body.scratch, null);
});

test('onRequestGet: with a token, lists and filters to cms/* PRs only', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('all')],
    ['repos/test-owner/test-repo/pulls', pullsPage([PR_A, { ...PR_B, head: { ref: 'unrelated' } }])],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestGet({ request: req(null, 'my-token'), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.prs.length, 1);
  assert.equal(body.prs[0].branch, 'cms/posts/a');
});

test('onRequestGet: scratch active (setting=custom) reports combined branches + preview status', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('custom', ['bulk-publish-123'])],
    ['repos/test-owner/test-repo/pulls', pullsPage([PR_A, PR_B])],
    ['compare/cms%2Fposts%2Fa...bulk-publish-123', jsonRes({ status: 'ahead' })], // A is part of scratch
    ['compare/cms%2Fposts%2Fb...bulk-publish-123', jsonRes({ status: 'diverged' })], // B is not
    [
      'pages/projects/fake-project/deployments',
      jsonRes({
        success: true,
        result: [
          {
            deployment_trigger: { metadata: { branch: 'bulk-publish-123' } },
            latest_stage: { name: 'deploy', status: 'success' },
            aliases: ['https://bulk-publish-123.example.pages.dev'],
          },
        ],
      }),
    ],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestGet({ request: req(null, 'my-token'), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.bulkModeOn, true);
  assert.equal(body.scratch.branch, 'bulk-publish-123');
  assert.deepEqual(body.scratch.combinedBranches, ['cms/posts/a']);
  assert.equal(body.scratch.preview.status, 'success');
  assert.equal(body.scratch.preview.url, 'https://bulk-publish-123.example.pages.dev');
});

test('onRequestGet: ?productionSha polls production deployment status by commit hash, ignores others', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('all')],
    [
      'pages/projects/fake-project/deployments',
      jsonRes({
        success: true,
        result: [
          { deployment_trigger: { metadata: { commit_hash: 'other-sha' } }, latest_stage: { name: 'deploy', status: 'success' } },
          {
            deployment_trigger: { metadata: { commit_hash: 'target-sha' } },
            latest_stage: { name: 'build', status: 'active' },
          },
        ],
      }),
    ],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestGet({
    request: req(null, null, 'https://example.pages.dev/admin/bulk-publish-api?productionSha=target-sha'),
    env: BASE_ENV,
  });
  const body = await res.json();
  assert.equal(body.production.status, 'building'); // build/active, not yet deploy/success
});

test('onRequestGet: no ?productionSha means production is null, no deployments call made', async () => {
  const mock = mockFetch([['pages/projects/fake-project', cfProject('all')]]);
  globalThis.fetch = mock.fn;
  const res = await onRequestGet({ request: req(), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.production, null);
  assert.equal(mock.calls.length, 1); // only the project-config read, no deployments lookup
});

// --- enable / disable ---

test('onRequestPost enable: sets preview_deployment_setting to none', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('all')],
    ['pages/projects/fake-project', jsonRes({ success: true, result: {} })],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({ request: req({ action: 'enable' }), env: BASE_ENV });
  const body = await res.json();
  assert.equal(body.bulkModeOn, true);
  assert.equal(mock.calls[1].method, 'PATCH');
  assert.equal(mock.calls[1].body.source.config.preview_deployment_setting, 'none');
});

test('onRequestPost disable: works with no token (never touches GitHub)', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('none')], // state check
    ['pages/projects/fake-project', cfProject('none')], // setPreviewConfig's own read
    ['pages/projects/fake-project', jsonRes({ success: true, result: {} })], // PATCH
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({ request: req({ action: 'disable' }), env: BASE_ENV });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.bulkModeOn, false);
});

test('onRequestPost disable: refuses while a scratch preview is active', async () => {
  const mock = mockFetch([['pages/projects/fake-project', cfProject('custom', ['bulk-publish-123'])]]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({ request: req({ action: 'disable' }), env: BASE_ENV });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.match(body.error, /bulk-publish-123/);
});

// --- combine ---

test('onRequestPost combine: 401 when no token supplied', async () => {
  const res = await onRequestPost({ request: req({ action: 'combine', branches: ['cms/a'] }), env: BASE_ENV });
  assert.equal(res.status, 401);
});

test('onRequestPost combine: 400 when branches empty', async () => {
  const res = await onRequestPost({ request: req({ action: 'combine', branches: [] }, 'tok'), env: BASE_ENV });
  assert.equal(res.status, 400);
});

test('onRequestPost combine: refuses when a scratch is already active', async () => {
  const mock = mockFetch([['pages/projects/fake-project', cfProject('custom', ['bulk-publish-123'])]]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({ request: req({ action: 'combine', branches: ['cms/posts/a'] }, 'tok'), env: BASE_ENV });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.match(body.error, /already active/);
});

test('onRequestPost combine: happy path -- creates scratch, merges branches in, narrows preview to just the scratch branch', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('none')], // state check
    ['repos/test-owner/test-repo/pulls', pullsPage([PR_A, PR_B])], // step-0 revalidation
    ['git/ref/heads/main', jsonRes({ object: { sha: 'main-sha' } })],
    ['git/refs', jsonRes({ ref: 'refs/heads/bulk-publish-xyz' })],
    ['repos/test-owner/test-repo/merges', jsonRes({ sha: 'merge-a-sha' })],
    ['repos/test-owner/test-repo/merges', jsonRes({ sha: 'merge-b-sha' })],
    ['pages/projects/fake-project', cfProject('none')], // setPreviewConfig's own read
    ['pages/projects/fake-project', jsonRes({ success: true, result: {} })], // PATCH to custom
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({
    request: req({ action: 'combine', branches: ['cms/posts/a', 'cms/posts/b'] }, 'tok'),
    env: BASE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.combinedBranches, ['cms/posts/a', 'cms/posts/b']);
  assert.ok(body.scratchBranch);

  const patchCall = mock.calls[mock.calls.length - 1];
  assert.equal(patchCall.method, 'PATCH');
  assert.equal(patchCall.body.source.config.preview_deployment_setting, 'custom');
  assert.deepEqual(patchCall.body.source.config.preview_branch_includes, [body.scratchBranch]);

  // Never touched main.
  const merges = mock.calls.filter((c) => c.url.includes('/merges'));
  assert.equal(merges.length, 2);
  assert.notEqual(merges[0].body.base, 'main');
  assert.notEqual(merges[1].body.base, 'main');
});

test('onRequestPost combine: merge conflict aborts, scratch left in place, preview config never touched', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('none')],
    ['repos/test-owner/test-repo/pulls', pullsPage([PR_A, PR_B])],
    ['git/ref/heads/main', jsonRes({ object: { sha: 'main-sha' } })],
    ['git/refs', jsonRes({ ref: 'refs/heads/bulk-publish-xyz' })],
    ['repos/test-owner/test-repo/merges', jsonRes({ sha: 'merge-a-sha' })],
    ['repos/test-owner/test-repo/merges', jsonRes({ message: 'conflict' }, 409)],
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({
    request: req({ action: 'combine', branches: ['cms/posts/a', 'cms/posts/b'] }, 'tok'),
    env: BASE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.conflictedBranch, 'cms/posts/b');
  assert.equal(mock.calls.length, 6); // no PATCH call attempted after the conflict
});

// --- publish-scratch / abandon-scratch ---

test('onRequestPost publish-scratch: 409 when scratchBranch does not match current state', async () => {
  const mock = mockFetch([['pages/projects/fake-project', cfProject('custom', ['bulk-publish-real'])]]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({
    request: req({ action: 'publish-scratch', scratchBranch: 'bulk-publish-stale' }, 'tok'),
    env: BASE_ENV,
  });
  assert.equal(res.status, 409);
});

test('onRequestPost publish-scratch: happy path -- derives combined branches via ancestry, merges to main, cleans up, restores all', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('custom', ['bulk-publish-123'])], // state check
    ['repos/test-owner/test-repo/pulls', pullsPage([PR_A, PR_B])],
    ['compare/cms%2Fposts%2Fa...bulk-publish-123', jsonRes({ status: 'identical' })],
    ['compare/cms%2Fposts%2Fb...bulk-publish-123', jsonRes({ status: 'ahead' })],
    ['repos/test-owner/test-repo/merges', jsonRes({ sha: 'final-sha' })], // scratch -> main
    ['git/refs/heads/bulk-publish-123', jsonRes({}, 204)], // delete scratch
    ['git/refs/heads/cms/posts/a', jsonRes({}, 204)],
    ['git/refs/heads/cms/posts/b', jsonRes({}, 204)],
    ['pages/projects/fake-project', cfProject('custom', ['bulk-publish-123'])], // setPreviewConfig's own read
    ['pages/projects/fake-project', jsonRes({ success: true, result: {} })], // PATCH to all
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({
    request: req({ action: 'publish-scratch', scratchBranch: 'bulk-publish-123' }, 'tok'),
    env: BASE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.published, ['cms/posts/a', 'cms/posts/b']);
  assert.equal(body.mainMergeSha, 'final-sha');
  assert.equal(body.bulkModeOn, false);

  const merges = mock.calls.filter((c) => c.url.includes('/merges'));
  assert.equal(merges.length, 1);
  assert.equal(merges[0].body.base, 'main');
  assert.equal(merges[0].body.head, 'bulk-publish-123');

  const lastPatch = mock.calls[mock.calls.length - 1];
  assert.equal(lastPatch.body.source.config.preview_deployment_setting, 'all');
});

test('onRequestPost abandon-scratch: deletes the scratch branch, resets to none (bulk mode stays on), leaves originals untouched', async () => {
  const mock = mockFetch([
    ['pages/projects/fake-project', cfProject('custom', ['bulk-publish-123'])], // state check
    ['git/refs/heads/bulk-publish-123', jsonRes({}, 204)], // delete scratch only
    ['pages/projects/fake-project', cfProject('custom', ['bulk-publish-123'])], // setPreviewConfig's own read
    ['pages/projects/fake-project', jsonRes({ success: true, result: {} })], // PATCH to none
  ]);
  globalThis.fetch = mock.fn;
  const res = await onRequestPost({
    request: req({ action: 'abandon-scratch', scratchBranch: 'bulk-publish-123' }, 'tok'),
    env: BASE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.bulkModeOn, true);
  assert.equal(body.scratchBranch, null);

  const lastPatch = mock.calls[mock.calls.length - 1];
  assert.equal(lastPatch.body.source.config.preview_deployment_setting, 'none');
  // Only the scratch branch was deleted -- no delete call for the
  // original cms/* branches, they're still open for a future combine.
  const deletes = mock.calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0].url.includes('bulk-publish-123'));
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
