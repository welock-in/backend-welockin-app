/**
 * Retire the data-driven cross-device focus notification. Idempotent — safe to
 * re-run. Needs a live DATABASE_URL.
 *   npm run notifications:seed
 *
 * HISTORY. This script used to seed the `focus_invited` template + rule that the
 * rule engine needed before it could push anything — which is exactly how the
 * feature died in production: the seed was never run there, and the engine
 * dropped every focus-invite push with nothing but a server-side warning.
 *
 * The focus-invite push is now sent directly by POST /focus-invites (modeled on
 * the admin console's send: resolveAudience + deliver, content in code), so it
 * needs NO seeded data. What remains here is the cleanup: disable the legacy
 * rows wherever they exist, so (a) the admin console stops showing wiring that
 * can no longer fire, and (b) a database that WAS seeded can never produce a
 * second, rule-driven push for the same invite. Disabled rather than deleted,
 * so the delivery history stays readable.
 */
import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  // The rule engine no longer receives a "focus.invited" event at all, and the
  // pc_locked predecessor broadcast to every device with no way to opt out.
  const rules = await prisma.notificationRule.updateMany({
    where: { OR: [{ event: "focus.invited" }, { templateKey: "pc_locked" }], enabled: true },
    data: { enabled: false },
  });

  // The template only existed to feed that rule; inactive keeps the admin
  // console truthful about what can actually send.
  const templates = await prisma.notificationTemplate.updateMany({
    where: { key: { in: ["focus_invited", "pc_locked"] }, active: true },
    data: { active: false },
  });

  console.log(
    `✔ Focus-invite push is code-owned (routes/focus-invites.ts) — disabled ${rules.count} legacy rule(s) and ${templates.count} legacy template(s).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
