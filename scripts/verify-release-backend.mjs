// Read-only production contract check. Credentials stay in the Vercel build;
// only health and the expected backend commit are checked, never signup offers.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_BACKEND_SOURCE_SHA, RELEASE_VERSION, loadPinnedManifest } from './publish-windows-release.mjs';

const API = 'https://app.connect.welock.in';
class BackendCheckError extends Error {}
const refuse = (code) => { throw new BackendCheckError(code); };

export async function verifyReleaseBackend({ env = process.env, fetchImpl = globalThis.fetch, manifest, log = console.log } = {}) {
  const requested = env.WINDOWS_RELEASE_VERSION;
  // A regular build performs no credential reads, file reads or requests.
  if (requested === undefined || requested === '') return { status: 'disabled' };
  if (requested !== RELEASE_VERSION) refuse('UNSUPPORTED_RELEASE_VERSION');
  if (env.VERCEL_ENV !== 'production') refuse('PRODUCTION_BUILD_REQUIRED');
  try { manifest ??= loadPinnedManifest(requested); }
  catch { refuse('PINNED_MANIFEST_UNAVAILABLE'); }
  if (manifest?.version !== requested || manifest?.backendSourceSha !== EXPECTED_BACKEND_SOURCE_SHA) refuse('BACKEND_SOURCE_NOT_PINNED');

  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) refuse('ADMIN_CREDENTIALS_UNAVAILABLE');

  async function request(path, options, label) {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch { refuse(`${label}_REQUEST_FAILED`); }
    if (!response.ok) refuse(`${label}_HTTP_${Number(response.status)}`);
    try { return await response.json(); }
    catch { refuse(`${label}_JSON_INVALID`); }
  }

  const login = await request('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  }, 'ADMIN_LOGIN');
  if (typeof login?.token !== 'string' || !login.token) refuse('ADMIN_LOGIN_INVALID');
  const headers = { Authorization: `Bearer ${login.token}` };
  const [health, db, config] = await Promise.all([
    request('/api/health', { method: 'GET' }, 'HEALTH'),
    request('/api/health/db', { method: 'GET' }, 'DATABASE_HEALTH'),
    request('/api/health/config', { method: 'GET', headers }, 'BACKEND_CONFIG'),
  ]);
  if (health?.ok !== true || db?.db !== 'ok') refuse('HEALTH_FAILED');
  // The public backend reports the seven-character source revision.
  if (config?.commit !== EXPECTED_BACKEND_SOURCE_SHA.slice(0, 7)) refuse('BACKEND_COMMIT_MISMATCH');
  const result = { status: 'verified', commit: config.commit };
  log(JSON.stringify({ check: 'production-backend', success: true, ...result }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyReleaseBackend().catch((error) => {
    console.error(error instanceof BackendCheckError ? error.message : 'PRODUCTION_CHECK_FAILED');
    process.exitCode = 1;
  });
}
