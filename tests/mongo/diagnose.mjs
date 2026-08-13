// Isolated diagnosis of the `prisma db push` hang. Not a test — a probe.
// Run: node tests/mongo/diagnose.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const runId = crypto.randomBytes(4).toString("hex");
const dbName = `welockin_qa_${runId}`;
const step = (m) => console.log(`[diag] ${new Date().toISOString().slice(11, 23)} ${m}`);

let rs = null;
let prisma = null;
try {
  step("starting MongoMemoryReplSet (wiredTiger, 1 node)…");
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  step("create() returned; waiting for the set to report primary…");
  await rs.waitUntilRunning();
  step("replica set is running");

  const uri = rs.getUri(dbName);
  step(`uri = ${uri}`);

  // The LOCAL binary, not npx: npx resolves over the network on a cold cache and
  // on Windows spawns an extra cmd layer, which is a plausible place to hang.
  const bin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "prisma.cmd" : "prisma",
  );
  step(`spawning ${bin} db push --schema prisma/schema.prisma --skip-generate`);

  const code = await new Promise((resolve) => {
    const child = spawn(bin, ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], {
      env: { ...process.env, DATABASE_URL: uri, DEBUG: process.env.DEBUG ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let last = "(no output at all)";
    const timer = setTimeout(() => {
      step(`TIMEOUT after 90s. Last line seen: ${last}`);
      child.kill("SIGKILL");
      resolve("TIMEOUT");
    }, 90_000);
    child.stdout.on("data", (b) => {
      const s = String(b).trim();
      if (s) { last = s; console.log(`  [push:out] ${s}`); }
    });
    child.stderr.on("data", (b) => {
      const s = String(b).trim();
      if (s) { last = s; console.log(`  [push:err] ${s}`); }
    });
    child.on("close", (c) => { clearTimeout(timer); resolve(c); });
    child.on("error", (e) => { clearTimeout(timer); console.log(`  [push:spawn-error] ${e.message}`); resolve("SPAWN-ERROR"); });
  });
  step(`db push finished with: ${code}`);
  if (code !== 0) throw new Error(`db push did not succeed (${code})`);

  step("connecting Prisma…");
  const { PrismaClient } = await import("@prisma/client");
  prisma = new PrismaClient({ datasources: { db: { url: uri } } });
  await prisma.$connect();
  step("connected");

  // The point of pushing at all: the REAL indexes, read back from the server.
  for (const coll of ["BillingTask", "Subscription", "TrialClaim", "ConsumedOrder"]) {
    const idx = await prisma.$runCommandRaw({ listIndexes: coll });
    const names = (idx?.cursor?.firstBatch ?? []).map((i) => `${i.name}${i.unique ? " UNIQUE" : ""}`);
    step(`${coll}: ${names.join(", ") || "(none)"}`);
  }
  step("DIAGNOSIS: db push works from a spawned local binary.");
} catch (e) {
  step(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  step("closing…");
  await prisma?.$disconnect().catch(() => {});
  await rs?.stop().catch(() => {});
  step("closed");
}
