// Explicit, one-release operation in Vercel's build environment. No secrets leave
// that environment except through the existing HTTPS admin authentication flow.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://app.connect.welock.in";
const VERSION = "0.3.46";
const ARTIFACT = "https://pub-9a9e884e54304893952b71510391fcd4.r2.dev/releases/0.3.46/welockin_0.3.46_x64-setup.exe";
const SOURCE_SHA = "6e67a788d1b7fa13ed67c32e4e3c2b20791473fc";
// SHA-256 of the manifest's JSON with top-level keys sorted. Whitespace/CRLF
// changes do not matter; changing any manifest value requires explicit review.
const MANIFEST_SHA256 = "af6b31e76c80dc33768dafa6f546bdec4b9a347a3b689d736eaa73b81c0f7358";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

class ReleaseError extends Error {}
const refuse = (code) => { throw new ReleaseError(code); };

export function loadPinnedManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(new URL("./releases/windows-0.3.46.json", import.meta.url), "utf8"));
  } catch {
    refuse("MANIFEST_UNREADABLE");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) refuse("MANIFEST_INVALID");
  const canonical = JSON.stringify(Object.fromEntries(Object.keys(manifest).sort().map((key) => [key, manifest[key]])));
  if (hash(canonical) !== MANIFEST_SHA256) refuse("MANIFEST_CHECKSUM_MISMATCH");
  return Object.freeze(manifest);
}

function validateManifest(m) {
  if (!m || m.version !== VERSION || m.target !== "windows" || m.arch !== "x86_64" ||
      m.channel !== "stable" || m.rolloutPercent !== 100 || m.url !== ARTIFACT || m.sourceSha !== SOURCE_SHA ||
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
function newerThanSupported(version) {
  if (typeof version !== "string") refuse("RELEASE_LIST_INVALID_VERSION");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) refuse("RELEASE_LIST_INVALID_VERSION");
  const expected = [0n, 3n, 46n];
  for (let index = 0; index < 3; index += 1) {
    const part = BigInt(match[index + 1]);
    if (part !== expected[index]) return part > expected[index];
  }
  return false;
}

function inspectRows(rows, manifest, signature) {
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object")) refuse("RELEASE_LIST_INVALID");
  const relevant = rows.filter((row) => row.target === manifest.target && row.arch === manifest.arch && row.channel === manifest.channel);
  if (relevant.some((row) => row.status === "live" && newerThanSupported(row.version))) refuse("NEWER_WINDOWS_RELEASE_IS_LIVE");
  const matches = relevant.filter((row) => row.version === VERSION);
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
        (row.status === "live" && row.rolloutPercent === 100))) refuse("RELEASE_STATUS_NOT_RESUMABLE");
}

export async function publishWindowsRelease({ env = process.env, fetchImpl = globalThis.fetch, manifest, log = console.log } = {}) {
  const requested = env.WINDOWS_RELEASE_VERSION;
  // This gate precedes every credential read, manifest read, and network call.
  if (requested === undefined || requested === "") return { status: "disabled" };
  if (requested !== VERSION) refuse("UNSUPPORTED_RELEASE_VERSION");
  if (env.VERCEL_ENV !== "production") refuse("PRODUCTION_BUILD_REQUIRED");
  manifest ??= loadPinnedManifest();
  validateManifest(manifest);

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
      method: "POST", headers, body: JSON.stringify({ rolloutPercent: 100 }),
    }, "PUBLISH_RELEASE");
    validateRow(published, manifest, signature, id);
    if (published.status !== "live") refuse("PUBLICATION_NOT_CONFIRMED");
  }

  const confirmed = inspectRows(await readRows(), manifest, signature);
  validateRow(confirmed, manifest, signature, id);
  if (confirmed.status !== "live") refuse("LIVE_READBACK_FAILED");
  const result = { status: alreadyLive ? "already-live" : "published", version: VERSION, id };
  log(JSON.stringify({ ...result, target: "windows", arch: "x86_64", rolloutPercent: 100, sha256: manifest.sha256 }));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishWindowsRelease().catch((error) => {
    console.error(error instanceof ReleaseError ? error.message : "WINDOWS_RELEASE_PUBLICATION_FAILED");
    process.exitCode = 1;
  });
}
