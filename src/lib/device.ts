import type { Request } from "express";
import type { Device } from "@prisma/client";

/** Header every client sets to say which physical device is calling. */
export const DEVICE_HEADER = "x-welockin-device-id";

/** The caller's device id, from the header, falling back to the body. */
export function readDeviceId(req: Request): string {
  const header = req.header(DEVICE_HEADER);
  if (header && header.trim()) return header.trim();
  const body = (req.body as { deviceId?: unknown } | undefined)?.deviceId;
  return typeof body === "string" ? body.trim() : "";
}

/**
 * Is this a device id we may key a PER-MACHINE decision on?
 *
 * `ensure_device_id` on the client collapses every machine that cannot read its
 * MachineGuid, volume serial, or a MAC to the SAME fixed string
 * (`win-unidentified`). Keying the one-trial-per-machine ledger on that shared
 * sink would be a bug in the dangerous direction: the first such machine to
 * start a trial would write the row, and every OTHER unreadable machine would
 * then be told "you already trialed" and charged immediately with no trial.
 *
 * So a shared or empty id is treated as "no device id at all" — the per-machine
 * check simply does not apply, and the account-level check still does. It fails
 * OPEN (the customer still gets their trial), never toward a wrong charge.
 */
export function isReliableDeviceId(id: string): boolean {
  const v = id.trim();
  if (!v) return false;
  // The client's last-resort fallback, and anything that decays to it.
  if (v === "win-unidentified" || v === "win-" || v === "unidentified") return false;
  return true;
}

/**
 * What a device looks like over the API. The counterpart of `toPublicUser`.
 *
 * GET /api/devices used to return the raw Prisma row, which handed every machine
 * on the account the iPhone's `idfv` — a hardware correlation hint — along with
 * `userId` and assorted server bookkeeping. An allow-list is the fix: fields not
 * named here cannot leak, including any added later.
 */
export type PublicDevice = {
  id: string;
  deviceId: string | null;
  name: string;
  platform: string;
  kind: string | null;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  /** Whether this row is the device that made the request. */
  isCurrent: boolean;
};

/**
 * `isCurrent` is computed HERE rather than by each client. iOS and Windows each
 * had their own comparison, which is how the same device could be badged
 * "this device" on one surface and not the other. One authority.
 */
export function toPublicDevice(device: Device, currentDeviceId?: string | null): PublicDevice {
  return {
    id: device.id,
    deviceId: device.deviceId ?? null,
    name: device.name,
    platform: device.platform,
    kind: device.kind ?? null,
    model: device.model ?? null,
    osVersion: device.osVersion ?? null,
    appVersion: device.appVersion ?? null,
    lastSeenAt: device.lastSeenAt,
    createdAt: device.createdAt,
    isCurrent: Boolean(currentDeviceId) && device.deviceId === currentDeviceId,
  };
}
