// Read-only impact audit. Emits aggregate counts/durations, never user/event IDs.
// Uses the actual old Prisma filter: Mongo null/missing differ from JS != true.
import { prisma } from "../src/lib/prisma";
import { auditFocusDurationImpact } from "../src/services/focus-duration-impact";

auditFocusDurationImpact(prisma).then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error instanceof Error ? error.name : "Read failed"); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
