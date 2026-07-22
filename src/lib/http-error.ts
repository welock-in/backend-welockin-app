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
