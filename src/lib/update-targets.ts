/**
 * Every platform the desktop updater serves — stated once, for both sides.
 *
 * The public manifest route reads this to decide what it will answer for, and
 * the admin write path reads it to decide what it will accept. Those two must
 * never drift: a release registered for a pair the reader does not recognise is
 * invisible, and nothing about it looks wrong. It sits in a draft, publishes
 * cleanly, reports a rollout percentage, and reaches nobody.
 *
 * The names are Tauri's own `{{target}}` and `{{arch}}` substitutions, which is
 * why macOS is `darwin` and not `macos` — the updater builds the URL it calls
 * from its own build triple, so these strings are dictated by the client, not
 * chosen here.
 *
 * ADDING A PLATFORM is one entry. Removing one silently strands every install
 * on it, since their update checks would start answering 204 forever — pause
 * the release instead.
 */
/**
 * The names a HUMAN writes, mapped to the triple above.
 *
 * A website link is written by a person, and `?target=darwin&arch=aarch64` asks
 * that person to know two things they have no business knowing: Tauri's build
 * triple, and which CPU the Mac build targets. Both are ours to keep track of.
 *
 * `macos` is the obvious word and it is deliberately NOT a valid `target` on the
 * updater path — an updater asking for `macos` is a client with a wrong build
 * triple and must be told so. Here it is the ONLY spelling, because here it is
 * a person typing a URL, not a machine reporting what it is.
 */
export const DOWNLOAD_ALIASES: Record<string, { target: string; arch: string }> = {
  windows: { target: "windows", arch: "x86_64" },
  macos: { target: "darwin", arch: "aarch64" },
};

export const UPDATE_TARGETS = [
  { target: "windows", arch: "x86_64" },
  /**
   * The macOS build is Apple-silicon only.
   *
   * `darwin/x86_64` is deliberately ABSENT rather than merely unbuilt. An Intel
   * Mac asking for an update must be told there is nothing — if it were ever
   * handed the aarch64 build it would download it, verify its signature happily,
   * install it, and then fail to launch. A missing update is a machine that
   * keeps working; a wrong-architecture update is a machine that does not.
   */
  { target: "darwin", arch: "aarch64" },
] as const;

export type UpdateTarget = (typeof UPDATE_TARGETS)[number];

/** Is this exactly one of the pairs above? Pairs, never fields independently. */
export function isSupportedTarget(target: string, arch: string): boolean {
  return UPDATE_TARGETS.some((t) => t.target === target && t.arch === arch);
}

/** "windows/x86_64, darwin/aarch64" — for error messages a human has to act on. */
export function supportedTargetList(): string {
  return UPDATE_TARGETS.map((t) => `${t.target}/${t.arch}`).join(", ");
}
