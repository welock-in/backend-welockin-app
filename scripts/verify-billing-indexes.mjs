#!/usr/bin/env node
/**
 * Does production actually have the unique indexes the money path relies on?
 *
 * WHY THIS EXISTS. `AcquisitionLock(userId, scope)` is the only thing standing
 * between two simultaneous clicks and two payable checkouts. On MongoDB that
 * guarantee is not in the schema file — it is an index in the cluster, and
 * Prisma's connector creates it only when someone runs a push. A deploy that
 * skipped one leaves an application that believes it is protected and a database
 * that is not, with no symptom until two requests arrive together and one
 * customer is billed twice.
 *
 * WHY IT ONLY READS. This runs against the live billing database. It lists
 * indexes and prints a verdict; it creates nothing, drops nothing, and touches
 * no document. When something is missing it prints the exact `createIndex` to
 * run — an additive, background build — rather than suggesting `prisma db push`,
 * which on MongoDB is free to drop and recreate indexes it does not recognise.
 *
 *   node scripts/verify-billing-indexes.mjs                 # verdict
 *   node scripts/verify-billing-indexes.mjs --print-fix     # + the commands
 *
 * Reads DATABASE_URL from the environment and never prints it: the connection
 * string carries the cluster password.
 */

import { MongoClient } from "mongodb";

/** What each index protects, in the words that matter if it is absent. */
const REQUIRED = [
  {
    collection: "AcquisitionLock",
    key: { userId: 1, scope: 1 },
    unique: true,
    protects:
      "one in-flight purchase per account. Without it, two simultaneous clicks " +
      "can each mint a payable Lemon Squeezy checkout and the customer pays twice.",
  },
  {
    collection: "CheckoutIntent",
    key: { token: 1 },
    unique: true,
    protects:
      "the public resume handle. Two intents sharing a token would make " +
      "'resume this checkout' ambiguous — on a link that takes money.",
  },
  {
    collection: "CheckoutIntent",
    key: { userId: 1, idempotencyKey: 1 },
    unique: true,
    protects:
      "a retry being the SAME intent rather than a new one. Without it a " +
      "retried request mints a second payable checkout.",
  },
  {
    collection: "CheckoutIntent",
    key: { userId: 1, state: 1 },
    unique: false,
    protects:
      "the lookup behind every eligibility read. Without it the paywall still " +
      "answers correctly, but scans the collection to do it.",
  },
  {
    collection: "Device",
    key: { deviceId: 1 },
    unique: false,
    protects:
      "the precheck's device-to-account lookup (POST /api/auth/precheck), which " +
      "asks for a deviceId ACROSS users. Every existing Device index is " +
      "userId-prefixed, so without this one an unauthenticated, rate-limited " +
      "endpoint scans the whole collection on every call.",
  },
];

/**
 * Rows that would REFUSE a unique index if it were created now.
 *
 * A unique build fails on existing duplicates, and the failure message names one
 * pair rather than the extent of the problem. Reporting them up front turns
 * "createIndex failed" into a list of exactly what to reconcile first — and it
 * reads only, so it is safe to run before deciding anything.
 */
async function duplicatesFor(db, spec) {
  const fields = Object.keys(spec.key);
  const id = Object.fromEntries(fields.map((f) => [f, `$${f}`]));
  return db
    .collection(spec.collection)
    .aggregate(
      [
        { $group: { _id: id, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $limit: 20 },
      ],
      { allowDiskUse: true },
    )
    .toArray();
}

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Export it for the environment you want to check.");
    process.exit(2);
  }

  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();
  // Named, never the URL — the connection string carries the password.
  console.log(`database: ${db.databaseName}\n`);

  const missing = [];
  for (const want of REQUIRED) {
    let found = null;
    try {
      const indexes = await db.collection(want.collection).indexes();
      found = indexes.find((i) => sameKey(i.key, want.key));
    } catch (e) {
      // An absent collection is not an error to this script: nothing has been
      // written yet, and the index will be created with the first write only if
      // it already exists in the cluster's definition — so it still counts as
      // missing, and says so rather than crashing.
      if (!/ns does not exist|NamespaceNotFound/i.test(String(e?.message))) throw e;
    }

    const keyStr = JSON.stringify(want.key);
    if (!found) {
      missing.push(want);
      console.log(`MISSING  ${want.collection} ${keyStr}${want.unique ? " unique" : ""}`);
      console.log(`         protects ${want.protects}\n`);
      continue;
    }
    // Present but not unique is the dangerous shape: it looks fine in a listing
    // and enforces nothing.
    if (want.unique && !found.unique) {
      missing.push(want);
      console.log(`NOT UNIQUE  ${want.collection} ${keyStr} — exists, enforces nothing`);
      console.log(`            protects ${want.protects}\n`);
      continue;
    }
    console.log(`ok       ${want.collection} ${keyStr}${found.unique ? " unique" : ""}`);
  }

  // Only for what is actually missing, and only when a unique build is at stake:
  // this is the question that decides whether createIndex can succeed at all.
  for (const m of missing.filter((x) => x.unique)) {
    let dups;
    try {
      dups = await duplicatesFor(db, m);
    } catch (e) {
      console.log(`\n${m.collection} ${JSON.stringify(m.key)}: duplicate scan failed — ${e?.message}`);
      continue;
    }
    if (dups.length === 0) {
      console.log(`\n${m.collection} ${JSON.stringify(m.key)}: no duplicates — a unique build can succeed.`);
    } else {
      // The KEYS, never the documents: these carry account ids, which are not
      // secrets but are not log fodder either, and nothing else is needed to
      // find them again.
      console.log(
        `\n${m.collection} ${JSON.stringify(m.key)}: ${dups.length} duplicate key(s) BLOCK a unique build:`,
      );
      for (const d of dups) console.log(`  ${JSON.stringify(d._id)} x${d.n}`);
      console.log("  Reconcile these before creating the index. Do not drop the index that exists.");
    }
  }

  if (missing.length > 0 && process.argv.includes("--print-fix")) {
    console.log("\nTo create them — additive, background, no drop:\n");
    for (const m of missing) {
      const opts = { background: true, ...(m.unique ? { unique: true } : {}) };
      console.log(`  db.${m.collection}.createIndex(${JSON.stringify(m.key)}, ${JSON.stringify(opts)})`);
    }
    console.log(
      "\nA unique index fails to build if duplicates already exist. That failure is\n" +
        "information, not an obstacle: resolve the duplicate rows first, and never\n" +
        "reach for `prisma db push` here — on MongoDB it may drop and recreate\n" +
        "indexes it does not recognise, on the live billing database.",
    );
  }

  await client.close();
  if (missing.length > 0) {
    console.log(
      `\n${missing.length} index(es) missing.` +
        (process.argv.includes("--print-fix") ? "" : " Re-run with --print-fix for the commands."),
    );
    process.exit(1);
  }
  console.log("\nAll billing indexes present.");
}

main().catch((e) => {
  console.error(`check failed: ${e?.message ?? e}`);
  process.exit(2);
});
