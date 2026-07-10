import type { NextFunction, Request, Response } from "express";
import type { Device } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { deviceNotBound, deviceRevoked, deviceSuperseded } from "../lib/http-error";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: Device;
    }
  }
}

const DEVICE_HEADER = "x-welockin-device-id";
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
/** A freshly-superseded phone keeps write access this long, so it can flush a
 *  backlog of focus events legitimately earned just before the rebind. Also used
 *  by the focus-event quarantine logic. */
export const DEVICE_GRACE_MS = 10 * 60 * 1000;

/** Read the caller's device id from the header, falling back to the body. */
function readDeviceId(req: Request): string {
  const header = req.header(DEVICE_HEADER);
  if (header && header.trim()) return header.trim();
  const body = (req.body as { deviceId?: unknown } | undefined)?.deviceId;
  return typeof body === "string" ? body.trim() : "";
}

/**
 * Gate phone-originated writes on a bound, active phone. MUST run after
 * requireAuth. Only enforces when the caller actually presents a device id:
 *
 *   - NO device id       → pass (a pre-Part-D client; new clients always send it,
 *                          and App Attest — when enabled — is the real teeth).
 *   - unknown id         → 403 DEVICE_NOT_BOUND (client registers, then retries)
 *   - revoked            → 403 DEVICE_REVOKED
 *   - superseded         → 403 DEVICE_SUPERSEDED, unless within DEVICE_GRACE_MS of
 *                          supersededAt (short flush window for legit backlog)
 *   - active / legacy    → pass (null status = legacy active)
 *
 * Do NOT apply to desktop clients or POST /api/sync push — those stay requireAuth
 * only.
 */
export function requireBoundDevice(req: Request, _res: Response, next: NextFunction): void {
  void (async () => {
    const userId = req.user!.id;
    const deviceId = readDeviceId(req);
    // Tolerate legacy clients with no device identity (additive, backward-compat).
    if (!deviceId) return;

    const device = await prisma.device.findFirst({ where: { userId, deviceId } });
    if (!device) throw deviceNotBound();
    if (device.kind === "desktop") throw deviceNotBound("Not a phone device");

    const status = device.status ?? "active"; // null legacy = active
    if (status === "revoked") throw deviceRevoked();
    if (status === "superseded") {
      const withinGrace =
        device.supersededAt != null &&
        Date.now() - device.supersededAt.getTime() <= DEVICE_GRACE_MS;
      if (!withinGrace) throw deviceSuperseded();
    } else if (status !== "active") {
      throw deviceNotBound();
    }

    req.device = device;

    // Throttled heartbeat — avoid a write on every request.
    const now = Date.now();
    if (!device.lastSeenAt || now - device.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await prisma.device
        .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {
          /* best-effort heartbeat */
        });
    }
  })().then(() => next(), next);
}
