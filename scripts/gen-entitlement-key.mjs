#!/usr/bin/env node
/**
 * Mint the Ed25519 keypair that signs entitlement receipts.
 *
 * The PRIVATE half goes in the backend environment and nowhere else. The PUBLIC
 * half is compiled into each desktop client, which is why it is printed as a
 * plain PEM: it is not a secret, and shipping it is the entire point — a client
 * that can verify a receipt without asking anyone is a client that still works
 * on a plane.
 *
 * Treat the private key like the updater key. Losing it costs no data, but every
 * receipt in the field stops verifying the moment it is replaced, so each machine
 * is locked until it can next reach the server.
 *
 *   node scripts/gen-entitlement-key.mjs
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pub = publicKey.export({ type: "spki", format: "pem" }).toString();

console.log("── PRIVATE — paste into the backend env as ENTITLEMENT_SIGNING_KEY ──");
console.log("   (base64 of the PEM, so a one-line dashboard field cannot mangle it)\n");
console.log(Buffer.from(priv).toString("base64"));
console.log("\n── PUBLIC — compile this into the desktop clients ──\n");
console.log(pub);
