/**
 * Grant (or revoke) admin on the feedback board.
 *
 *   npm run feedback:set-admin -- --id <userId>
 *   npm run feedback:set-admin -- --email <email>
 *   npm run feedback:set-admin -- --email <email> --revoke
 *
 * Gate is the User.isAdmin column (never an email allowlist — Sign in with Apple
 * Private Relay would break that).
 */
import { prisma } from "../src/lib/prisma";

function parseArgs(argv: string[]): { id?: string; email?: string; revoke: boolean } {
  const out: { id?: string; email?: string; revoke: boolean } = { revoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--id") out.id = argv[++i];
    else if (a === "--email") out.email = argv[++i]?.trim().toLowerCase();
    else if (a === "--revoke") out.revoke = true;
  }
  return out;
}

async function main(): Promise<void> {
  const { id, email, revoke } = parseArgs(process.argv.slice(2));
  if (!id && !email) {
    throw new Error("Provide --id <userId> or --email <email>");
  }

  const user = id
    ? await prisma.user.findUnique({ where: { id } })
    : await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`No user found for ${id ? `id ${id}` : `email ${email}`}`);
  }

  await prisma.user.update({ where: { id: user.id }, data: { isAdmin: !revoke } });
  console.log(`${revoke ? "Revoked" : "Granted"} admin for user ${user.id} (${user.email ?? "no email"})`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
