/**
 * An error carrying an HTTP status code. Thrown from routes/services and
 * turned into a `{ error: string }` JSON body by the error middleware.
 */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = "Unauthorized") => new HttpError(401, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
