import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { publishWindowsRelease } from './publish-windows-release.mjs';

const API_BASE = 'https://app.connect.welock.in';
const ARTIFACT_URL = 'https://pub-9a9e884e54304893952b71510391fcd4.r2.dev/releases/0.3.46/welockin_0.3.46_x64-setup.exe';
const ARTIFACT = Buffer.from('small deterministic installer fixture');
const SIGNATURE_BYTES = Buffer.from('dGVzdC11cGRhdGVyLXNpZ25hdHVyZQ==\n');
const SIGNATURE = SIGNATURE_BYTES.toString('utf8').trim();
const TOKEN = 'fixture-admin-token-must-never-be-logged';
const PASSWORD = 'fixture-admin-password-must-never-be-logged';
const RELEASE_ID = 'release-046';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const MANIFEST = Object.freeze({
  version: '0.3.46',
  target: 'windows',
  arch: 'x86_64',
  channel: 'stable',
  rolloutPercent: 100,
  url: ARTIFACT_URL,
  sha256: sha256(ARTIFACT),
  sizeBytes: ARTIFACT.length,
  signatureSha256: sha256(SIGNATURE_BYTES),
  signatureSizeBytes: SIGNATURE_BYTES.length,
  sourceSha: '6e67a788d1b7fa13ed67c32e4e3c2b20791473fc',
  notes: 'New desktop accounts receive lifetime access.',
});

const ENV = Object.freeze({
  WINDOWS_RELEASE_VERSION: '0.3.46',
  VERCEL_ENV: 'production',
  ADMIN_USERNAME: 'fixture-admin',
  ADMIN_PASSWORD: PASSWORD,
});

function release(overrides = {}) {
  return {
    id: RELEASE_ID,
    version: MANIFEST.version,
    target: MANIFEST.target,
    arch: MANIFEST.arch,
    channel: MANIFEST.channel,
    url: MANIFEST.url,
    signature: SIGNATURE,
    sha256: MANIFEST.sha256,
    sizeBytes: MANIFEST.sizeBytes,
    notes: MANIFEST.notes,
    status: 'draft',
    rolloutPercent: 0,
    ...overrides,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Every route is simulated locally. Unexpected hosts, routes, redirects or
// authenticated public downloads fail immediately instead of reaching a network.
function scenario(options = {}) {
  let rows = structuredClone(options.initialReleases ?? []);
  let listCount = 0;
  let publishCount = 0;
  const calls = [];
  const logs = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body == null ? undefined : JSON.parse(String(init.body));
    calls.push({ url: url.href, pathname: url.pathname, method, body });
    assert.equal(init.redirect, 'error', 'every fetch must reject HTTP redirects');
    assert.equal(url.protocol, 'https:');

    if (url.href === ARTIFACT_URL || url.href === `${ARTIFACT_URL}.sig`) {
      assert.equal(method, 'GET');
      assert.equal(headers.has('authorization'), false, 'public artifact requests must not carry the admin token');
      assert.equal(headers.has('cookie'), false);
      if (options.downloadFailure) return new Response(options.downloadFailure.body, { status: options.downloadFailure.status });
      const bytes = url.href.endsWith('.sig')
        ? (options.signatureBytes ?? SIGNATURE_BYTES)
        : (options.artifactBytes ?? ARTIFACT);
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }

    assert.equal(url.origin, API_BASE, 'credentials and token may only go to the fixed admin API');
    assert.equal(url.search, '');
    const pathname = url.pathname.replace(/\/$/, '');
    if (pathname === '/api/admin/login') {
      assert.equal(method, 'POST');
      assert.equal(headers.has('authorization'), false);
      assert.deepEqual(body, { username: ENV.ADMIN_USERNAME, password: ENV.ADMIN_PASSWORD });
      assert.deepEqual(calls.slice(0, 2).map((call) => call.url), [ARTIFACT_URL, `${ARTIFACT_URL}.sig`], 'artifact and signature are checked before authentication');
      if (options.loginFailure) return new Response(options.loginFailure.body, { status: options.loginFailure.status });
      return json(options.loginResponse ?? { token: TOKEN });
    }

    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    if (pathname === '/api/admin/releases' && method === 'GET') {
      listCount += 1;
      if (options.listFailure) return new Response(options.listFailure.body, { status: options.listFailure.status });
      if (publishCount > 0 && options.readbackRows !== undefined) return json({ releases: options.readbackRows });
      if (listCount === 2 && options.prepublishRows !== undefined) rows = structuredClone(options.prepublishRows);
      return json({ releases: rows });
    }
    if (pathname === '/api/admin/releases' && method === 'POST') {
      assert.deepEqual({
        version: body.version,
        target: body.target,
        arch: body.arch,
        channel: body.channel,
        url: body.url,
        sha256: body.sha256,
        sizeBytes: body.sizeBytes,
        signature: body.signature,
        notes: body.notes,
      }, {
        version: MANIFEST.version,
        target: MANIFEST.target,
        arch: MANIFEST.arch,
        channel: MANIFEST.channel,
        url: MANIFEST.url,
        sha256: MANIFEST.sha256,
        sizeBytes: MANIFEST.sizeBytes,
        signature: SIGNATURE,
        notes: MANIFEST.notes,
      });
      const created = release(options.createOverrides);
      rows.push(created);
      return json(created, 201);
    }
    if (pathname === `/api/admin/releases/${RELEASE_ID}/publish` && method === 'POST') {
      publishCount += 1;
      assert.deepEqual(body, { rolloutPercent: 100 });
      const published = release({ status: 'live', rolloutPercent: 100, ...options.publishOverrides });
      rows = rows.map((row) => row.id === RELEASE_ID ? published : row);
      return json(published);
    }
    assert.fail(`Unexpected simulated request: ${method} ${url.href}`);
  };
  return {
    calls,
    logs,
    run: (overrides = {}) => publishWindowsRelease({
      env: ENV,
      manifest: MANIFEST,
      fetchImpl,
      log: (...args) => logs.push(args.map(String).join(' ')),
      ...overrides,
    }),
  };
}

function mutations(calls) {
  return calls.filter((call) => call.method !== 'GET' && call.pathname !== '/api/admin/login');
}

function assertNoSecrets(value) {
  const text = String(value);
  assert.equal(text.includes(TOKEN), false, 'admin token must not appear in output');
  assert.equal(text.includes(PASSWORD), false, 'admin password must not appear in output');
}

test('absent release flag performs no reads of credentials or environment and no network calls', async () => {
  const env = new Proxy({}, {
    get(_target, key) {
      assert.equal(key, 'WINDOWS_RELEASE_VERSION', `disabled script must not read ${String(key)}`);
      return undefined;
    },
  });
  const mock = scenario();
  assert.deepEqual(await mock.run({ env }), { status: 'disabled' });
  assert.equal(mock.calls.length, 0);
  assertNoSecrets(mock.logs.join('\n'));
});

for (const overrides of [
  { VERCEL_ENV: 'preview' },
  { VERCEL_ENV: 'development' },
  { VERCEL_ENV: undefined },
  { WINDOWS_RELEASE_VERSION: '0.3.47' },
  { WINDOWS_RELEASE_VERSION: ' 0.3.46 ' },
]) {
  test(`invalid activation is rejected before network: ${JSON.stringify(overrides)}`, async () => {
    const mock = scenario();
    await assert.rejects(mock.run({ env: { ...ENV, ...overrides } }));
    assert.equal(mock.calls.length, 0);
  });
}

for (const overrides of [
  { version: '0.3.47' },
  { target: 'darwin' },
  { arch: 'aarch64' },
  { channel: 'beta' },
  { rolloutPercent: 50 },
  { url: 'https://example.org/another-installer.exe' },
  { sourceSha: 'f'.repeat(40) },
]) {
  test(`manifest target is pinned: ${JSON.stringify(overrides)}`, async () => {
    const mock = scenario();
    await assert.rejects(mock.run({ manifest: { ...MANIFEST, ...overrides } }));
    assert.equal(mock.calls.length, 0);
  });
}

for (const [label, options] of [
  ['installer hash', { artifactBytes: Buffer.from('x'.repeat(ARTIFACT.length)) }],
  ['installer size', { artifactBytes: Buffer.concat([ARTIFACT, Buffer.from('x')]) }],
  ['signature hash', { signatureBytes: Buffer.from('x'.repeat(SIGNATURE_BYTES.length)) }],
  ['signature size', { signatureBytes: Buffer.concat([SIGNATURE_BYTES, Buffer.from('x')]) }],
]) {
  test(`${label} mismatch aborts before authentication`, async () => {
    const mock = scenario(options);
    await assert.rejects(mock.run());
    assert.equal(mock.calls.some((call) => call.url.startsWith(API_BASE)), false);
    assert.equal(mutations(mock.calls).length, 0);
  });
}

test('creates the expected draft, publishes only its id at 100 percent, and reads it back', async () => {
  const mock = scenario();
  assert.deepEqual(await mock.run(), { status: 'published', version: '0.3.46', id: RELEASE_ID });
  assert.deepEqual(mock.calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /releases/0.3.46/welockin_0.3.46_x64-setup.exe',
    'GET /releases/0.3.46/welockin_0.3.46_x64-setup.exe.sig',
    'POST /api/admin/login',
    'GET /api/admin/releases',
    'POST /api/admin/releases',
    'GET /api/admin/releases',
    `POST /api/admin/releases/${RELEASE_ID}/publish`,
    'GET /api/admin/releases',
  ]);
  assertNoSecrets(mock.logs.join('\n'));
});

test('resumes an identical draft without creating another row', async () => {
  const mock = scenario({ initialReleases: [release()] });
  assert.deepEqual(await mock.run(), { status: 'published', version: '0.3.46', id: RELEASE_ID });
  assert.deepEqual(mutations(mock.calls).map((call) => call.pathname), [`/api/admin/releases/${RELEASE_ID}/publish`]);
});

test('an identical live release at 100 percent is an idempotent read-only success', async () => {
  const mock = scenario({ initialReleases: [release({ status: 'live', rolloutPercent: 100 })] });
  assert.deepEqual(await mock.run(), { status: 'already-live', version: '0.3.46', id: RELEASE_ID });
  assert.equal(mutations(mock.calls).length, 0);
  assertNoSecrets(mock.logs.join('\n'));
});

for (const [label, prepublishRows] of [
  ['a newer release has become live', [
    release(),
    release({ id: 'concurrent-newer-release', version: '0.3.100', status: 'live', rolloutPercent: 100 }),
  ]],
  ['the target metadata has changed', [release({ signature: 'concurrent-conflicting-signature' })]],
  ['the target release id has changed', [release({ id: 'concurrent-replacement-release' })]],
  ['the target release has disappeared', []],
]) {
  test(`rechecks immediately before publication and stops when ${label}`, async () => {
    const mock = scenario({ prepublishRows });
    await assert.rejects(mock.run());
    assert.deepEqual(mutations(mock.calls).map((call) => call.pathname), ['/api/admin/releases']);
    assert.equal(mock.calls.at(-1).method, 'GET');
    assert.equal(mock.calls.at(-1).pathname, '/api/admin/releases');
    assert.equal(mock.logs.length, 0);
  });
}

for (const [label, initialReleases, expectedMutations] of [
  ['newly created draft', [], ['/api/admin/releases']],
  ['resumed draft', [release()], []],
]) {
  test(`avoids duplicate publication when an identical ${label} becomes live concurrently`, async () => {
    const mock = scenario({
      initialReleases,
      prepublishRows: [release({ status: 'live', rolloutPercent: 100 })],
    });
    assert.deepEqual(await mock.run(), { status: 'already-live', version: '0.3.46', id: RELEASE_ID });
    assert.deepEqual(mutations(mock.calls).map((call) => call.pathname), expectedMutations);
    assertNoSecrets(mock.logs.join('\n'));
  });
}

for (const overrides of [
  { url: 'https://example.org/conflicting.exe' },
  { signature: 'different-signature' },
  { sha256: '0'.repeat(64) },
  { sizeBytes: MANIFEST.sizeBytes + 1 },
  { notes: 'Different release notes' },
  { installerUrl: 'https://example.org/different-setup.exe' },
  { id: '' },
  { id: '../unrelated-release' },
  { status: 'paused' },
  { status: 'superseded' },
  { status: 'live', rolloutPercent: 50 },
  { status: 'draft', rolloutPercent: 100 },
]) {
  test(`refuses an unsafe existing target release without mutation: ${JSON.stringify(overrides)}`, async () => {
    const mock = scenario({ initialReleases: [release(overrides)] });
    await assert.rejects(mock.run());
    assert.equal(mutations(mock.calls).length, 0);
  });
}

test('refuses to publish over a newer live Windows release', async () => {
  const mock = scenario({ initialReleases: [release({ id: 'newer-release', version: '0.3.100', status: 'live', rolloutPercent: 100 })] });
  await assert.rejects(mock.run());
  assert.equal(mutations(mock.calls).length, 0);
});

test('newer releases for a different platform or channel do not prevent the Windows stable update', async () => {
  const mock = scenario({ initialReleases: [
    release({ id: 'mac-release', version: '0.4.0', target: 'darwin', arch: 'aarch64', status: 'live', rolloutPercent: 100 }),
    release({ id: 'beta-release', version: '0.4.0', channel: 'beta', status: 'live', rolloutPercent: 100 }),
  ] });
  assert.equal((await mock.run()).status, 'published');
  assert.equal(mutations(mock.calls).length, 2);
});

for (const overrides of [
  { version: '0.3.47' },
  { target: 'darwin' },
  { arch: 'aarch64' },
  { channel: 'beta' },
  { signature: 'wrong-signature' },
  { sha256: 'f'.repeat(64) },
  { sizeBytes: 1 },
  { status: 'live', rolloutPercent: 100 },
  { id: '' },
]) {
  test(`does not publish a tampered creation response: ${JSON.stringify(overrides)}`, async () => {
    const mock = scenario({ createOverrides: overrides });
    await assert.rejects(mock.run());
    assert.deepEqual(mutations(mock.calls).map((call) => call.pathname), ['/api/admin/releases']);
  });
}

for (const overrides of [
  { id: 'different-release' },
  { status: 'draft' },
  { rolloutPercent: 50 },
  { url: 'https://example.org/incorrect.exe' },
]) {
  test(`does not report success for a tampered publication response: ${JSON.stringify(overrides)}`, async () => {
    const mock = scenario({ publishOverrides: overrides });
    await assert.rejects(mock.run());
    assert.equal(mock.logs.length, 0);
  });
}

test('does not report success when the published release disappears on final readback', async () => {
  const mock = scenario({ readbackRows: [] });
  await assert.rejects(mock.run());
  assert.equal(mock.logs.length, 0);
});

test('final readback must preserve the published release id and complete metadata', async () => {
  const mock = scenario({ readbackRows: [release({ id: 'different-release', status: 'live', rolloutPercent: 100 })] });
  await assert.rejects(mock.run());
  assert.equal(mock.logs.length, 0);
});

for (const kind of ['loginFailure', 'listFailure', 'downloadFailure']) {
  test(`${kind} never includes credentials, token or raw response in errors or logs`, async () => {
    const rawBody = `RAW_ERROR_BODY ${PASSWORD} ${TOKEN}`;
    const mock = scenario({ [kind]: { status: kind === 'loginFailure' ? 401 : 503, body: rawBody } });
    await assert.rejects(mock.run(), (error) => {
      assertNoSecrets(error.stack ?? error);
      assert.equal(String(error).includes('RAW_ERROR_BODY'), false);
      return true;
    });
    assertNoSecrets(mock.logs.join('\n'));
    assert.equal(mutations(mock.calls).length, 0);
  });
}

test('an authentication response without a token cannot reach release endpoints', async () => {
  const mock = scenario({ loginResponse: { username: ENV.ADMIN_USERNAME } });
  await assert.rejects(mock.run());
  assert.equal(mock.calls.some((call) => call.pathname.startsWith('/api/admin/releases')), false);
});
