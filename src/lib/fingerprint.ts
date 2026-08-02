import { createHmac } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { prisma } from "./prisma";
import { env } from "./env";

/**
 * The composite hardware fingerprint, and the rule for deciding that two
 * requests came from the same machine.
 *
 * WHY A COMPOSITE. The requirement was "key it on the MAC address so two
 * accounts cannot be created on one machine". A MAC alone cannot carry that,
 * and the failure is in both directions at once:
 *
 *   - Windows randomises Wi-Fi MACs per network by default, every VPN and
 *     hypervisor adds invented ones, and `Set-NetAdapter -MacAddress` changes a
 *     real one in two clicks. So a MAC is neither stable nor trustworthy.
 *   - A USB dock or adapter carries its MAC between laptops. Two colleagues
 *     sharing one dock would look like one machine.
 *
 * Keyed on the MAC alone, the honest user who unplugs a dock looks like a new
 * machine while the fraudster who spoofs one looks like an old machine —
 * exactly backwards. So a MAC is recorded, and never decides on its own.
 *
 * THE RULE. Two requests are the same machine when EITHER:
 *   - the MachineGuid matches (survives docks, Wi-Fi toggles, reboots — it only
 *     changes on a Windows reinstall or a deliberate registry edit); OR
 *   - the volume serial matches AND at least one MAC matches (this is the leg
 *     that survives a MachineGuid reset, and needing two signals is what stops
 *     a shared dock from merging two machines).
 *
 * A MAC on its own, or a volume serial on its own, is recorded as a weak signal
 * and never concludes anything.
 *
 * TRUST. The whole payload is self-declared: a patched client sends whatever it
 * likes. This follows the ledger's existing discipline for `hardwareBacked` —
 * a client's claim about its own hardware may WEAKEN its position, never
 * strengthen it. So a matching fingerprint can cost someone a trial; a missing
 * or unrecognised one never grants one.
 */

export const FINGERPRINT_HEADER = "x-welockin-fingerprint";

/** The three signal kinds. Never compared across kinds. */
export type SignalKind = "mguid" | "vol" | "mac";

export type Signal = { kind: SignalKind; hash: string };

/**
 * The wire shape, kept terse because it rides on every auth request as a header.
 * Bounds everywhere: this is attacker-controlled input that becomes database
 * rows.
 */
const wireSchema = z.object({
  mg: z.string().trim().min(8).max(64).optional(),
  vs: z.string().trim().min(4).max(32).optional(),
  mac: z.array(z.string().trim().regex(/^[0-9a-f]{12}$/)).max(8).optional(),
  hw: z.boolean().optional(),
});

export type ParsedFingerprint = {
  signals: Signal[];
  /** True when the machine id came from hardware rather than a fallback. */
  hardwareBacked: boolean;
};

/**
 * Keyed hash, same pepper as the trial ledger.
 *
 * Deliberately shared: these hashes describe the very machines the ledger is
 * about and live in the same trust boundary, so a separate key would add a
 * rotation hazard and no security. The `kind` is inside the hashed string, so a
 * MAC and a volume serial that happen to share a raw value still produce
 * different hashes and can never cross-match.
 */
export function fingerprintHash(kind: SignalKind, raw: string): string {
  return createHmac("sha256", env.trialLedgerPepper)
    .update(`fp:v1:${kind}:${raw.toLowerCase()}`)
    .digest("hex");
}

/** Decode the header (or body field) into hashed signals. Never throws. */
export function parseFingerprint(req: Request): ParsedFingerprint {
  const header = req.header(FINGERPRINT_HEADER);
  const raw =
    header && header.trim()
      ? header.trim()
      : typeof (req.body as { fingerprint?: unknown } | undefined)?.fingerprint === "string"
        ? ((req.body as { fingerprint: string }).fingerprint ?? "").trim()
        : "";

  if (!raw) return { signals: [], hardwareBacked: false };

  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    const parsed = wireSchema.safeParse(json);
    if (!parsed.success) return { signals: [], hardwareBacked: false };

    const { mg, vs, mac, hw } = parsed.data;
    const signals: Signal[] = [];
    if (mg) signals.push({ kind: "mguid", hash: fingerprintHash("mguid", mg) });
    if (vs) signals.push({ kind: "vol", hash: fingerprintHash("vol", vs) });
    for (const m of mac ?? []) signals.push({ kind: "mac", hash: fingerprintHash("mac", m) });

    return { signals, hardwareBacked: hw === true && Boolean(mg) };
  } catch {
    // Malformed input is absence, not an error. A client that garbles its own
    // fingerprint should be treated as a machine we have never seen, not have
    // its request refused.
    return { signals: [], hardwareBacked: false };
  }
}

/**
 * Which existing trial claim, if any, this machine already belongs to.
 *
 * Returns the OLDEST match: the first claim decides. If a newer one could win,
 * accumulating identities would be a way to accumulate trials, which is the one
 * thing this table exists to prevent.
 */
export async function matchClaimByFingerprint(signals: Signal[]): Promise<string | null> {
  if (signals.length === 0) return null;

  const rows = await prisma.deviceSignal.findMany({
    where: { OR: signals.map((s) => ({ kind: s.kind, hash: s.hash })) },
    select: { claimId: true, kind: true },
    orderBy: { firstSeenAt: "asc" },
  });
  if (rows.length === 0) return null;

  const byClaim = new Map<string, Set<string>>();
  for (const row of rows) {
    const kinds = byClaim.get(row.claimId) ?? new Set<string>();
    kinds.add(row.kind);
    byClaim.set(row.claimId, kinds);
  }

  for (const [claimId, kinds] of byClaim) {
    if (kinds.has("mguid")) return claimId;
    if (kinds.has("vol") && kinds.has("mac")) return claimId;
  }

  // Only weak signals lined up — a shared dock, or one MAC in common. Not a
  // match, on purpose.
  return null;
}

/**
 * Record what this machine looks like, against a claim.
 *
 * Upsert, so re-seeing a signal touches `lastSeenAt` rather than growing the
 * table. Rows ACCUMULATE and are never replaced: plugging a dock back in adds a
 * MAC instead of losing the one recorded without it, which is what keeps an
 * honest user's machine recognisable as their hardware changes around it.
 */
export async function recordSignals(claimId: string, signals: Signal[]): Promise<void> {
  const now = new Date();
  for (const s of signals) {
    try {
      await prisma.deviceSignal.upsert({
        where: { claimId_kind_hash: { claimId, kind: s.kind, hash: s.hash } },
        create: { claimId, kind: s.kind, hash: s.hash, firstSeenAt: now, lastSeenAt: now },
        update: { lastSeenAt: now },
      });
    } catch (e) {
      // Best-effort by design: a bookkeeping write must never cost someone the
      // request they were making.
      console.warn("[fingerprint] failed to record a device signal", e);
    }
  }
}

/**
 * The account this machine already belongs to, if registration should be
 * refused.
 *
 * Returns null when the owning account has been DELETED (`firstUserId` null, or
 * a row that no longer exists). Deleting your account must not brick your
 * computer. The claim itself survives regardless, so the anti-farm guarantee
 * holds either way — this only decides whether to refuse outright.
 */
export async function findBlockingClaimOwner(
  signals: Signal[],
): Promise<{ claimId: string; userId: string } | null> {
  const claimId = await matchClaimByFingerprint(signals);
  if (!claimId) return null;

  const claim = await prisma.trialClaim.findUnique({
    where: { id: claimId },
    select: { id: true, firstUserId: true },
  });
  if (!claim?.firstUserId) return null;

  const owner = await prisma.user.findUnique({
    where: { id: claim.firstUserId },
    select: { id: true },
  });
  if (!owner) return null;

  return { claimId: claim.id, userId: owner.id };
}
