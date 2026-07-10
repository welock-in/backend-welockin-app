/**
 * An error carrying an HTTP status code. Thrown from routes/services and turned
 * into a JSON body by the error middleware. Beyond `status` + `message` it can
 * carry a machine-readable `code` (so clients branch reliably instead of matching
 * on human strings) and arbitrary `details` (extra fields spread into the body).
 */
export class HttpError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    opts?: { code?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const tooManyRequests = (msg = "Too many requests") => new HttpError(429, msg);

// --- Device identity / anti-abuse (Part D) ---------------------------------
// The mobile client branches on these `code` values (DEVICE_NOT_BOUND etc).
export const deviceNotBound = (msg = "This device isn’t bound to your account") =>
  new HttpError(403, msg, { code: "DEVICE_NOT_BOUND" });
export const deviceSuperseded = (msg = "This iPhone is no longer the active device") =>
  new HttpError(403, msg, { code: "DEVICE_SUPERSEDED" });
export const deviceRevoked = (msg = "This device has been revoked") =>
  new HttpError(403, msg, { code: "DEVICE_REVOKED" });
export const deviceConflict = (
  activeDevice: { name?: string | null; model?: string | null; lastSeenAt?: Date | null },
  msg = "Another iPhone is already active on this account",
) => new HttpError(409, msg, { code: "DEVICE_CONFLICT", details: { activeDevice } });
export const rebindCooldown = (msg = "You changed devices recently — try again later") =>
  new HttpError(429, msg, { code: "REBIND_COOLDOWN" });
