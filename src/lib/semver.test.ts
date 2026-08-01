import assert from "node:assert/strict";
import test from "node:test";
import { compare, isValid, parse, toSortKey } from "./semver";

test("compare orders by numeric field, not lexically", () => {
  // The classic trap: "0.10.0" < "0.2.0" as strings, but 10 > 2 as a minor.
  assert.equal(compare("0.10.0", "0.2.0"), 1);
  assert.equal(compare("0.2.0", "0.10.0"), -1);
  assert.equal(compare("1.0.0", "0.99.99"), 1);
  assert.equal(compare("0.2.1", "0.2.0"), 1);
  assert.equal(compare("0.2.0", "0.2.0"), 0);
});

test("a release outranks its own prereleases", () => {
  assert.equal(compare("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compare("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compare("1.0.0-rc.2", "1.0.0-rc.1"), 1);
});

test("isValid rejects the shapes we must never publish", () => {
  assert.ok(isValid("0.2.0"));
  assert.ok(isValid("1.0.0-rc.1"));
  // A leading v would sort wrong and break the artifact filename convention.
  assert.equal(isValid("v0.2.0"), false);
  assert.equal(isValid("0.2"), false);
  assert.equal(isValid(""), false);
  assert.equal(isValid("latest"), false);
});

test("toSortKey sorts the same way compare does", () => {
  const versions = ["0.2.0", "0.10.0", "1.0.0-rc.1", "1.0.0", "0.2.1"];
  // Byte order, NOT localeCompare: Mongo sorts strings binary by default, and
  // that is the only ordering `toSortKey` is designed to satisfy (locale
  // collation reorders punctuation like `~` and would break the prerelease
  // rule). If a collation is ever added to the releases index, this breaks.
  const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const bySortKey = [...versions].sort((a, b) => byteOrder(toSortKey(a), toSortKey(b)));
  const byCompare = [...versions].sort(compare);
  assert.deepEqual(bySortKey, byCompare);
  assert.deepEqual(byCompare, ["0.2.0", "0.2.1", "0.10.0", "1.0.0-rc.1", "1.0.0"]);
});

test("parse throws nothing and returns null on junk", () => {
  assert.equal(parse("nope"), null);
  assert.deepEqual(parse("0.2.0"), { major: 0, minor: 2, patch: 0, prerelease: null });
});
