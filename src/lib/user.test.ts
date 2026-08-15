import assert from "node:assert/strict";
import { test } from "node:test";
import { maskEmail } from "./user";

/*
 * `maskEmail` is what stands between the unauthenticated precheck and a doxxing
 * surface: the endpoint's whole job is to tell a STRANGER that this phone has a
 * paying account, and the mask is the only thing that keeps that answer from
 * naming the account. So the tests pin the exact output — a "cosmetic" change
 * that reveals one more character is a privacy change, and it should have to
 * come here and say so.
 */

test("maskEmail keeps one local char, two domain chars, and the TLD", () => {
  assert.equal(maskEmail("hedi.fourati@epfl.ch"), "h•••@ep•••.ch");
  assert.equal(maskEmail("owner@example.com"), "o•••@ex•••.com");
});

test("maskEmail never reveals more than exists on short parts", () => {
  assert.equal(maskEmail("a@b.co"), "a•••@b•••.co");
  assert.equal(maskEmail("ab@cd.io"), "a•••@cd•••.io");
});

test("maskEmail keeps only the FIRST domain label's head on deep domains", () => {
  // The mask must not grow with the domain: subdomains are folded away.
  assert.equal(maskEmail("user@mail.epfl.ch"), "u•••@ma•••.ch");
});

test("maskEmail handles an Apple private-relay address like any other", () => {
  assert.equal(maskEmail("x9k2p1@privaterelay.appleid.com"), "x•••@pr•••.com");
});

test("maskEmail is total: junk in, masked junk out, never a throw", () => {
  // A one-label domain has no TLD to keep.
  assert.equal(maskEmail("a@localhost"), "a•••@lo•••");
  // No "@" at all: mask the whole thing rather than invent structure.
  assert.equal(maskEmail("not-an-email"), "n•••");
  // Empty local part.
  assert.equal(maskEmail("@epfl.ch"), "•••@ep•••.ch");
  assert.equal(maskEmail(""), "•••");
});

test("maskEmail is deterministic — the same address always masks the same way", () => {
  assert.equal(maskEmail("hedi.fourati@epfl.ch"), maskEmail("hedi.fourati@epfl.ch"));
});
