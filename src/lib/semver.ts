// Minimal semver support for the desktop auto-updater. Deliberately tiny and
// dependency-free (same spirit as lib/deterministic-id.ts): we only ever compare
// our own release numbers, which are plain `major.minor.patch` with an optional
// prerelease tag.

const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export interface Parsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parse(version: string): Parsed | null {
  const m = RE.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

export function isValid(version: string): boolean {
  return parse(version) !== null;
}

/** -1 / 0 / 1, like Array#sort. Throws on an unparseable input. */
export function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`Invalid semver: ${!pa ? a : b}`);

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  // A release outranks any prerelease of the same numbers (1.0.0 > 1.0.0-rc.1).
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0;
}

/**
 * Lexicographically sortable form, so Mongo can order releases in a `$sort`
 * without any semver logic. Zero-padded numbers, and `~` for a plain release so
 * it sorts AFTER every prerelease of the same numbers (`~` > every alphanumeric
 * in ASCII), matching `compare` above.
 */
export function toSortKey(version: string): string {
  const p = parse(version);
  if (!p) throw new Error(`Invalid semver: ${version}`);
  const pad = (n: number) => String(n).padStart(6, "0");
  return `${pad(p.major)}.${pad(p.minor)}.${pad(p.patch)}-${p.prerelease ?? "~"}`;
}
