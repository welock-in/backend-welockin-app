// Loads .env, for its side effect and BEFORE the client is constructed below.
//
// Prisma resolves `env("DATABASE_URL")` at client construction, reading only the
// real process environment — so without this, anything that imports prisma
// WITHOUT also importing env sees no .env at all. That was every script in
// `scripts/`: `npm run device:migrate` as the README documents it could only ever
// work if DATABASE_URL happened to be exported in the shell already, and failed
// with "Environment variable not found" otherwise. The server path always
// imported env first and so never showed it.
import "./env";
import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across hot-reloads in development to avoid
// exhausting the database connection pool.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
