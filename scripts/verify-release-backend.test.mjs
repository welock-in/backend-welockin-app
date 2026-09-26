import assert from 'node:assert/strict';
import test from 'node:test';
import { EXPECTED_BACKEND_SOURCE_SHA, RELEASE_VERSION } from './publish-windows-release.mjs';
import { verifyReleaseBackend } from './verify-release-backend.mjs';

const API = 'https://app.connect.welock.in';
const PASSWORD = 'fixture-backend-password-must-not-be-logged';
const TOKEN = 'fixture-backend-token-must-not-be-logged';
const MANIFEST = Object.freeze({ version: RELEASE_VERSION, backendSourceSha: EXPECTED_BACKEND_SOURCE_SHA });
const ENV = Object.freeze({ WINDOWS_RELEASE_VERSION: RELEASE_VERSION, VERCEL_ENV: 'production', ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: PASSWORD });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function scenario(options = {}) {
  const calls = [];
  const logs = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, method: init.method });
    assert.equal(url.origin, API);
    assert.equal(url.search, '');
    assert.equal(init.redirect, 'error');
    const headers = new Headers(init.headers);
    if (options.throwTransport) throw new Error(`transport ${PASSWORD} ${TOKEN}`);
    if (options.failPath === url.pathname) return new Response(`remote ${PASSWORD} ${TOKEN}`, { status: 503 });
    if (options.invalidJsonPath === url.pathname) return new Response(`invalid ${PASSWORD} ${TOKEN}`, { status: 200 });
    if (url.pathname === '/api/admin/login') {
      assert.equal(init.method, 'POST');
      assert.equal(headers.has('authorization'), false);
      assert.deepEqual(JSON.parse(init.body), { username: ENV.ADMIN_USERNAME, password: PASSWORD });
      return json(options.login ?? { token: TOKEN });
    }
    assert.equal(init.method, 'GET', 'the preflight must never mutate backend state');
    assert.equal(init.body, undefined);
    if (url.pathname === '/api/health/config') {
      assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
      return json(options.config ?? { commit: EXPECTED_BACKEND_SOURCE_SHA.slice(0, 7) });
    }
    assert.equal(headers.has('authorization'), false, 'public health requests carry no token');
    if (url.pathname === '/api/health') return json(options.health ?? { ok: true });
    if (url.pathname === '/api/health/db') return json(options.db ?? { db: 'ok' });
    assert.fail(`Unexpected request: ${url.pathname}`);
  };
  return {
    calls, logs,
    run: (overrides = {}) => verifyReleaseBackend({ env: ENV, manifest: MANIFEST, fetchImpl, log: (line) => logs.push(line), ...overrides }),
  };
}

function assertNoSecrets(value) {
  assert.equal(String(value).includes(PASSWORD), false);
  assert.equal(String(value).includes(TOKEN), false);
}

test('an ordinary build performs no credential reads or network requests', async () => {
  const env = new Proxy({}, { get(_target, key) { assert.equal(key, 'WINDOWS_RELEASE_VERSION'); return undefined; } });
  const mock = scenario();
  assert.deepEqual(await mock.run({ env }), { status: 'disabled' });
  assert.deepEqual(mock.calls, []);
});

for (const overrides of [
  { WINDOWS_RELEASE_VERSION: '0.3.48' },
  { WINDOWS_RELEASE_VERSION: '0.3.51' },
  { WINDOWS_RELEASE_VERSION: ` ${RELEASE_VERSION} ` },
  { VERCEL_ENV: 'preview' },
  { VERCEL_ENV: undefined },
]) {
  test(`rejects invalid operation activation before requests: ${JSON.stringify(overrides)}`, async () => {
    const mock = scenario();
    await assert.rejects(mock.run({ env: { ...ENV, ...overrides } }));
    assert.deepEqual(mock.calls, []);
  });
}

for (const manifest of [{ ...MANIFEST, version: '0.3.48' }, { ...MANIFEST, backendSourceSha: 'f'.repeat(40) }, { version: RELEASE_VERSION }]) {
  test(`rejects an unpinned backend source before credential reads: ${JSON.stringify(manifest)}`, async () => {
    const env = new Proxy(ENV, { get(target, key) { assert.ok(!String(key).startsWith('ADMIN_')); return target[key]; } });
    const mock = scenario();
    await assert.rejects(mock.run({ env, manifest }));
    assert.deepEqual(mock.calls, []);
  });
}

test('verifies production health and commit without reading signup or entitlement settings', async () => {
  const mock = scenario({ config: { commit: EXPECTED_BACKEND_SOURCE_SHA.slice(0, 7), entitlement: { enforced: false, receiptsEnabled: false } } });
  assert.deepEqual(await mock.run(), { status: 'verified', commit: EXPECTED_BACKEND_SOURCE_SHA.slice(0, 7) });
  assert.deepEqual(mock.calls, [
    { path: '/api/admin/login', method: 'POST' },
    { path: '/api/health', method: 'GET' },
    { path: '/api/health/db', method: 'GET' },
    { path: '/api/health/config', method: 'GET' },
  ]);
  assertNoSecrets(mock.logs.join('\n'));
  assert.equal(mock.logs.join('\n').includes('entitlement'), false);
});

test('the actual pinned 0.3.50 manifest selects the expected production backend', async () => {
  const mock = scenario();
  assert.deepEqual(await mock.run({ manifest: undefined }), { status: 'verified', commit: EXPECTED_BACKEND_SOURCE_SHA.slice(0, 7) });
  assert.equal(mock.calls.length, 4);
  assertNoSecrets(mock.logs.join('\n'));
});

for (const options of [{ health: { ok: false } }, { db: { db: 'error' } }, { config: { commit: '0000000' } }, { login: {} }]) {
  test(`rejects invalid backend evidence without success output: ${JSON.stringify(options)}`, async () => {
    const mock = scenario(options);
    await assert.rejects(mock.run());
    assert.deepEqual(mock.logs, []);
  });
}

for (const options of [
  { throwTransport: true },
  { failPath: '/api/admin/login' },
  { failPath: '/api/health/config' },
  { invalidJsonPath: '/api/admin/login' },
  { invalidJsonPath: '/api/health/config' },
]) {
  test(`suppresses remote errors and secrets: ${JSON.stringify(options)}`, async () => {
    const mock = scenario(options);
    await assert.rejects(mock.run(), (error) => { assertNoSecrets(error.stack ?? error); return true; });
    assert.deepEqual(mock.logs, []);
  });
}
