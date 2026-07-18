/**
 * Seed the flagship cross-device notification: "PC locked → notify the phone".
 * Idempotent — safe to re-run. Needs a live DATABASE_URL.
 *   npm run notifications:seed
 *
 * This is a bootstrap for the data-driven engine; once the admin CRUD ships,
 * templates + rules are editable from the console (no code, no re-seed).
 */
import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  await prisma.notificationTemplate.upsert({
    where: { key: "pc_locked" },
    update: {},
    create: {
      key: "pc_locked",
      title: "Your computer locked",
      body: "Tap to start a focus session on this phone.",
      category: "cross_device",
      // Deep-link the client routes on tap → opens Start Focus (pre-filled).
      data: { type: "cross_device_lock", route: "/start-focus", params: { source: "desktop" } },
    },
  });

  const event = "session.started";
  const existing = await prisma.notificationRule.findFirst({
    where: { event, templateKey: "pc_locked" },
  });
  if (!existing) {
    await prisma.notificationRule.create({
      data: {
        name: "PC locked → notify phone",
        event,
        condition: { platform: { $in: ["windows", "macos"] } },
        templateKey: "pc_locked",
        audience: { mode: "sameUserOtherDevices", excludeOrigin: true },
        dedupeKeyTemplate: "pc_locked:{{sessionId}}",
        enabled: true,
      },
    });
  }

  console.log("✔ Seeded notification template + rule (pc_locked).");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
