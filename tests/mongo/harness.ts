import crypto from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * A disposable MongoDB for the billing tests that genuinely need one.
 *
 * WHY A REPLICA SET AND NOT A PLAIN SERVER. Prisma's MongoDB connector refuses
 * to run against a standalone `mongod` — transactions require an oplog — and the
 * billing paths under test here are exactly the ones that lean on real database
 * behaviour: unique indexes, atomic conditional updates, and the races between
 * two callers arriving at the same instant. A mock cannot answer any of those
 * questions; that is the whole reason this suite is separate from `npm test`.
 *
 * Every run gets its own database name carrying a `runId`, so two runs (or a
 * run and a leftover) can never see each other's rows, and cleanup is a single
 * unambiguous drop.
 */
export const runId = process.env.BILLING_QA_RUN_ID ?? crypto.randomBytes(4).toString("hex");
export const dbName = `welockin_qa_${runId}`;

let replset: MongoMemoryReplSet | null = null;

export async function startMongo(): Promise<string> {
  // A single-node replica set: enough for an oplog, and far faster to start
  // than three nodes that would tell us nothing extra about our own code.
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  // Explicit: create() resolves before the set has elected a primary, and
  // pushing a schema at a set with no primary is the other way this hangs.
  await replset.waitUntilRunning();

  // getUri(name) already carries `?replicaSet=…`, which is what makes Prisma
  // treat this as transaction-capable instead of refusing to start against a
  // standalone mongod. Appending our own replicaSet parameter produced a
  // duplicate and Prisma rejected the whole string (P1013).
  const uri = replset.getUri(dbName);
  process.env.DATABASE_URL = uri;

  await pushSchema(uri);
  return uri;
}

/**
 * Create the REAL indexes, the way production creates them.
 *
 * WHY THIS IS A SPAWN AND NOT `execFileSync("npx", …)`, which is what it was:
 * on Windows `npx` inserts a `cmd` layer and the synchronous call never
 * returned — the whole suite hung with no output at all. The local binary,
 * spawned, with `DATABASE_URL` passed explicitly, finishes in under a second.
 * The timeout is deliberately short: a hang here is a bug to see, not one to
 * wait out.
 */
function pushSchema(uri: string): Promise<void> {
  const bin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "prisma.cmd" : "prisma",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], {
      env: { ...process.env, DATABASE_URL: uri },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let tail = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`prisma db push timed out after 90s. Last output: ${tail || "(none)"}`));
    }, 90_000);
    const note = (b: Buffer) => {
      const line = String(b).trim();
      if (line) tail = line;
    };
    child.stdout.on("data", note);
    child.stderr.on("data", note);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not spawn prisma: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`prisma db push exited ${code}: ${tail}`));
    });
  });
}

export async function stopMongo(): Promise<void> {
  if (!replset) return;
  await replset.stop();
  replset = null;
}
