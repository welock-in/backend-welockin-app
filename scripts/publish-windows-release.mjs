// Explicit, pinned-release operation in Vercel's build environment. No secrets leave
// that environment except through the existing HTTPS admin authentication flow.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://app.connect.welock.in";
export const RELEASE_VERSION = "0.3.51";
export const EXPECTED_BACKEND_SOURCE_SHA = "2c35cbc31132a5f19b83e67bd9d798a9d4885339";
// SHA-256 of the manifest's JSON with top-level keys sorted. Whitespace/CRLF
// changes do not matter; changing any manifest value requires explicit review.
const RELEASE_PINS = Object.freeze({
  "0.3.46": Object.freeze({
    sourceSha: "6e67a788d1b7fa13ed67c32e4e3c2b20791473fc",
    manifestSha256: "af6b31e76c80dc33768dafa6f546bdec4b9a347a3b689d736eaa73b81c0f7358",
  }),
  "0.3.47": Object.freeze({
    sourceSha: "afea3e800cfb1fcd09c63faae15dfa8bd3430bc9",
    manifestSha256: "3c2725d86227d91a3d531e67fdd0457d31821195a1cf96865a60aaf7259e2be6",
  }),
  "0.3.48": Object.freeze({
    sourceSha: "aacef762fe9ba680c89bb3b4aa57137208f5b300",
    backendSourceSha: "dcb2c4658c71eb24b31c62c784b1a41707773fb4",
    manifestSha256: "13d300627e3738fccf5edfecd5292fd6a63fa29bf8b73852bca590c09acc2ac3",
  }),
  "0.3.49": Object.freeze({
    sourceSha: "8656b34e30e0ab5057e60e5c0504b603d89f8fed",
    backendSourceSha: "dcb2c4658c71eb24b31c62c784b1a41707773fb4",
    manifestSha256: "05733b6c553a0ed0bc84f2b1e0923efa9001987b76f4f51cb52213bdbc40070f",
  }),
  "0.3.50": Object.freeze({
    sourceSha: "cbb467117a651ac446c6cc350bb58db190080390",
    backendSourceSha: "64b8470f02b971b8cdf8ce56781d3b1702e465af",
    rolloutPercent: 0,
    manifestSha256: "db7cae4e47db770fbb9df7deffa8baffc6cbc12c0fe3da6ccc64b9452deb9897",
  }),
  "0.3.51": Object.freeze({
    sourceSha: "dc64a1906b8ba3ad2dc014d875ab2a87e1d4a6c6",
    backendSourceSha: EXPECTED_BACKEND_SOURCE_SHA,
    rolloutPercent: 0,
    manifestSha256: "9e74c86c532cd5c712cfea90517cdd8f99c59514603be57ff880b120bf71df6f",
  }),
});
const artifactUrl = (version) => `https://pub-9a9e884e54304893952b71510391fcd4.r2.dev/releases/${version}/welockin_${version}_x64-setup.exe`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

class ReleaseError extends Error {}
const refuse = (code) => { throw new ReleaseError(code); };

function requireCompletePins(version) {
  if (typeof version !== "string" || !Object.hasOwn(RELEASE_PINS, version)) refuse("UNSUPPORTED_RELEASE_VERSION");
  const pins = RELEASE_PINS[version];
  if (!/^[a-f0-9]{40}$/.test(pins.sourceSha) || !/^[a-f0-9]{64}$/.test(pins.manifestSha256)) refuse("RELEASE_PINS_INCOMPLETE");
}

export function loadPinnedManifest(version = "0.3.46") {
  requireCompletePins(version);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(new URL(`./releases/windows-${version}.json`, import.meta.url), "utf8"));
  } catch {
    refuse("MANIFEST_UNREADABLE");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) refuse("MANIFEST_INVALID");
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map((key) => [key, manifest[key]])));
  if (hash(canonical) !== RELEASE_PINS[version].manifestSha256) refuse("MANIFEST_CHECKSUM_MISMATCH");
  return Object.freeze(manifest);
}

function validateManifest(m, version) {
  if (!m || m.version !== version || m.target !== "windows" || m.arch !== "x86_64" ||
      m.channel !== "stable" || m.rolloutPercent !== (RELEASE_PINS[version].rolloutPercent ?? 100) || m.url !== artifactUrl(version) || m.sourceSha !== RELEASE_PINS[version].sourceSha ||
      (RELEASE_PINS[version].backendSourceSha && m.backendSourceSha !== RELEASE_PINS[version].backendSourceSha) ||
      !/^[a-f0-9]{64}$/.test(m.sha256) || !/^[a-f0-9]{64}$/.test(m.signatureSha256) ||
      !Number.isSafeInteger(m.sizeBytes) || m.sizeBytes <= 0 ||
      !Number.isSafeInteger(m.signatureSizeBytes) || m.signatureSizeBytes <= 0 ||
      (m.notes !== undefined && (typeof m.notes !== "string" || m.notes.length > 4000))) {
    refuse("MANIFEST_INVALID");
  }
}

// The supported release has no prerelease tag. Compare numeric components to
// avoid treating, for example, 0.3.100 as older than 0.3.46. A prerelease of the
// same numeric version is older; any higher numeric version is newer.
function newerThanSupported(version, supportedVersion) {
  if (typeof version !== "string") refuse("RELEASE_LIST_INVALID_VERSION");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) refuse("RELEASE_LIST_INVALID_VERSION");
  const expected = supportedVersion.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    const part = BigInt(match[index + 1]);
    if (part !== expected[index]) return part > expected[index];
  }
  return false;
}

function inspectRows(rows, manifest, signature) {
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object")) refuse("RELEASE_LIST_INVALID");
  const relevant = rows.filter((row) => row.target === manifest.target && row.arch === manifest.arch && row.channel === manifest.channel);
  if (relevant.some((row) => row.status === "live" && newerThanSupported(row.version, manifest.version))) refuse("NEWER_WINDOWS_RELEASE_IS_LIVE");
  const matches = relevant.filter((row) => row.version === manifest.version);
  if (matches.length > 1) refuse("DUPLICATE_RELEASE_ROWS");
  if (matches[0]) validateRow(matches[0], manifest, signature);
  return matches[0];
}

function validateRow(row, manifest, signature, expectedId) {
  if (!row || typeof row !== "object" || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.id) ||
      (expectedId !== undefined && row.id !== expectedId) ||
      row.version !== manifest.version || row.target !== manifest.target || row.arch !== manifest.arch ||
      row.channel !== manifest.channel || row.url !== manifest.url || row.sha256 !== manifest.sha256 ||
      row.sizeBytes !== manifest.sizeBytes || row.signature !== signature ||
      (row.notes ?? "") !== (manifest.notes ?? "") ||
      (row.installerUrl != null && row.installerUrl !== manifest.url)) {
    refuse("IMMUTABLE_RELEASE_COLLISION");
  }
  if (!((row.status === "draft" && row.rolloutPercent === 0) ||
        (row.status === "live" && row.rolloutPercent === manifest.rolloutPercent))) refuse("RELEASE_STATUS_NOT_RESUMABLE");
}

export async function publishWindowsRelease({ env = process.env, fetchImpl = globalThis.fetch, manifest, log = console.log } = {}) {
  const requested = env.WINDOWS_RELEASE_VERSION;
  // This gate precedes every credential read, manifest read, and network call.
  if (requested === undefined || requested === "") return { status: "disabled" };
  requireCompletePins(requested);
  if (env.VERCEL_ENV !== "production") refuse("PRODUCTION_BUILD_REQUIRED");
  manifest ??= loadPinnedManifest(requested);
  validateManifest(manifest, requested);

  async function request(url, options, label) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(60_000) });
    } catch {
      // Never forward fetch errors: injected transports or remote error bodies
      // can include credentials, tokens, or request data.
      refuse(`${label}_REQUEST_FAILED`);
    }
    if (!response.ok) refuse(`${label}_HTTP_${Number(response.status)}`);
    return response;
  }

  async function artifactBytes(url, size, digest, label) {
    const response = await request(url, { method: "GET" }, label);
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); }
    catch { refuse(`${label}_BODY_UNREADABLE`); }
    if (bytes.length !== size || hash(bytes) !== digest) refuse(`${label}_CHECKSUM_MISMATCH`);
    return bytes;
  }

  await artifactBytes(manifest.url, manifest.sizeBytes, manifest.sha256, "ARTIFACT");
  const signatureBytes = await artifactBytes(`${manifest.url}.sig`, manifest.signatureSizeBytes, manifest.signatureSha256, "SIGNATURE");
  const signature = signatureBytes.toString("utf8").trim();
  if (!signature) refuse("SIGNATURE_EMPTY");

  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  if (typeof username !== "string" || !username || typeof password !== "string" || !password) refuse("ADMIN_CREDENTIALS_UNAVAILABLE");

  async function jsonRequest(path, options, label) {
    const response = await request(`${API}${path}`, options, label);
    try { return await response.json(); }
    catch { refuse(`${label}_JSON_INVALID`); }
  }

  const login = await jsonRequest("/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
  }, "ADMIN_LOGIN");
  if (!login || typeof login.token !== "string" || !login.token) refuse("ADMIN_LOGIN_INVALID");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` };
  const readRows = async () => {
    const data = await jsonRequest("/api/admin/releases", { method: "GET", headers }, "LIST_RELEASES");
    return data?.releases;
  };

  let row = inspectRows(await readRows(), manifest, signature);
  let alreadyLive = row?.status === "live";
  if (!row) {
    row = await jsonRequest("/api/admin/releases", {
      method: "POST", headers,
      body: JSON.stringify({
        version: manifest.version, target: manifest.target, arch: manifest.arch, channel: manifest.channel,
        url: manifest.url, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, signature, notes: manifest.notes ?? "",
      }),
    }, "CREATE_DRAFT");
    validateRow(row, manifest, signature);
    if (row.status !== "draft") refuse("CREATED_RELEASE_IS_NOT_DRAFT");
  }

  const id = row.id;
  if (row.status === "draft") {
    // Another operator may have published or replaced a release since our
    // initial listing/creation. Recheck immediately before this mutation.
    row = inspectRows(await readRows(), manifest, signature);
    validateRow(row, manifest, signature, id);
    alreadyLive = row.status === "live";
  }
  if (row.status === "draft") {
    const published = await jsonRequest(`/api/admin/releases/${id}/publish`, {
      method: "POST", headers, body: JSON.stringify({ rolloutPercent: manifest.rolloutPercent }),
    }, "PUBLISH_RELEASE");
    validateRow(published, manifest, signature, id);
    if (published.status !== "live") refuse("PUBLICATION_NOT_CONFIRMED");
  }

  const confirmed = inspectRows(await readRows(), manifest, signature);
  validateRow(confirmed, manifest, signature, id);
  if (confirmed.status !== "live") refuse("LIVE_READBACK_FAILED");
  const result = { status: alreadyLive ? "already-live" : "published", version: manifest.version, id };
  log(JSON.stringify({ ...result, target: "windows", arch: "x86_64", rolloutPercent: manifest.rolloutPercent, sha256: manifest.sha256 }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishWindowsRelease().catch((error) => {
    console.error(error instanceof ReleaseError ? error.message : "WINDOWS_RELEASE_PUBLICATION_FAILED");
    process.exitCode = 1;
  });
}
