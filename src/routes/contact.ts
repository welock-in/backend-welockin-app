import { Router } from "express";
import { asyncHandler } from "../middleware/async-handler";
import { HttpError } from "../lib/http-error";
import { CONTACT_INBOX, sendContactEmail } from "../lib/resend";
import { clientIp, consumeRateLimit } from "../lib/rate-limit";
import { contactSchema } from "../validation/schemas";

/**
 * The marketing site's contact form: one public POST that forwards the message
 * to the support inbox.
 *
 * No auth, on purpose — the people most likely to write in (locked out, cannot
 * sign in, do not have an account yet) are exactly the ones a bearer-token
 * requirement would turn away. And unlike the reset flow next door there is no
 * enumeration concern: the endpoint stores nothing and looks nothing up, so
 * there is nothing an answer could leak.
 *
 * What replaces auth is the pair of rate limits: the IP one stops one machine
 * spraying the inbox, and the address one stops a sender rotating IPs behind a
 * single identity. Neither is a security boundary (see lib/rate-limit.ts) —
 * they only keep the inbox usable.
 */
export const contactRouter = Router();

const minutes = (n: number) => n * 60 * 1000;

contactRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, email, topic, message } = contactSchema.parse(req.body);

    await consumeRateLimit(`contact:ip:${clientIp(req)}`, 5, minutes(60));
    await consumeRateLimit(`contact:email:${email}`, 3, minutes(60));

    const result = await sendContactEmail({ name, email, topic }, message);

    if (result.ok) {
      res.json({ ok: true });
      return;
    }

    if (result.skipped) {
      // No RESEND_API_KEY. Loud in the log, but still a 200 to the browser: a
      // dev environment without email configured must not present a broken
      // form. `delivered: false` is the honest half — a client that wants to
      // tell the user "email us directly instead" can.
      console.error(
        `[contact] RESEND_API_KEY not set — contact message from ${email} was NOT delivered`,
      );
      res.json({ ok: true, delivered: false });
      return;
    }

    // A configured mailer that genuinely failed. Unlike the skip above this is
    // an outage, not a setup choice — and a quiet 200 here would swallow the
    // one message its sender may have no other way to send. The body names the
    // fallback address for exactly that reason.
    console.error(`[contact] delivery failed for ${email}: ${result.error ?? "unknown error"}`);
    throw new HttpError(
      502,
      `We could not deliver your message — email us directly at ${CONTACT_INBOX}`,
      { code: "CONTACT_DELIVERY_FAILED" },
    );
  }),
);
