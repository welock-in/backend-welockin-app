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
    key: { userId: 1, state: 1 },
    unique: false,
    protects:
      "the lookup behind every eligibility read. Without it the paywall still " +
      "answers correctly, but scans the collection to do it.",
  },
];

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
