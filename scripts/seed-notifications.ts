/**
 * Seed the cross-device focus notification. Idempotent — safe to re-run.
 * Needs a live DATABASE_URL.
 *   npm run notifications:seed
 *
 * This is a bootstrap for the data-driven engine; templates + rules are editable
 * from the admin console afterwards (no code, no re-seed).
 */
import { prisma } from "../src/lib/prisma";

async function main(): Promise<void> {
  await prisma.notificationTemplate.upsert({
    where: { key: "focus_invited" },
    update: {
      title: "{{fromDeviceName}} started a focus",
      body: "{{durationMinutes}} min. Tap to lock this phone too.",
    },
    create: {
      key: "focus_invited",
      title: "{{fromDeviceName}} started a focus",
      body: "{{durationMinutes}} min. Tap to lock this phone too.",
      category: "cross_device",
      // Deep-links Start Focus, pre-filled from the invite. The phone still
      // picks WHAT to block: iOS app selections are opaque Screen Time tokens
      // that no other device can name.
      data: {
        type: "cross_device_lock",
        route: "/start-focus",
        params: {
          source: "desktop",
          sessionId: "{{sessionId}}",
          min: "{{durationMinutes}}",
          hard: "{{hardLock}}",
        },
      },
    },
  });

  const event = "focus.invited";
  const existing = await prisma.notificationRule.findFirst({
    where: { event, templateKey: "focus_invited" },
  });
  if (!existing) {
    await prisma.notificationRule.create({
      data: {
        name: "Focus invite → notify the chosen devices",
        event,
        // No condition: the route already decided who is invited. Filtering
        // again here could only ever contradict the user's explicit pick.
        condition: {},
        templateKey: "focus_invited",
        // The whole point of the invite flow: notify the devices the user
        // SELECTED, not everything they own.
        audience: { mode: "specificDevices" },
        dedupeKeyTemplate: "focus_invited:{{sessionId}}",
        enabled: true,
      },
    });
  }

  // Retire the broadcast predecessor. It fires on `session.started` for every
  // other device on the account, with no way to opt a device out — so leaving it
  // enabled means TWO pushes for one session, one of them ignoring the user's
  // selection. Disabled rather than deleted, so the delivery history stays
  // readable and re-enabling is one click in the admin console.
  const retired = await prisma.notificationRule.updateMany({
    where: { templateKey: "pc_locked", enabled: true },
    data: { enabled: false },
  });

  console.log("✔ Seeded focus_invited template + rule (audience: specificDevices).");
  if (retired.count > 0) {
    console.log(`✔ Disabled ${retired.count} legacy pc_locked rule(s) — they broadcast to every device.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
