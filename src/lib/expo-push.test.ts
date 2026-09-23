import assert from "node:assert/strict";
import { test } from "node:test";
import { sendExpoPush } from "./expo-push";

test("a short first batch never associates second-batch tickets with wrong tokens", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true, status: 200,
    json: async () => ({ data: ++calls === 1 ? [{ status: "ok", id: "first" }] : [{ status: "ok", id: "last" }] }),
  }));
  const tokens = Array.from({ length: 101 }, (_, n) => `ExponentPushToken[device-${n}]`);
  const results = await sendExpoPush(tokens, { title: "hello", body: "test" });
  assert.equal(results[0].ticketId, "first");
  assert.equal(results[1].status, "error");
  assert.equal(results[99].status, "error");
  assert.equal(results[100].ticketId, "last");
});

test("temporary HTTP failure is retried once and expiration reaches Expo", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, opts: any) => {
    assert.equal(JSON.parse(opts.body)[0].expiration, 12345);
    return ++calls === 1 ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => ({ data: [{ status: "ok", id: "recovered" }] }) };
  });
  const [result] = await sendExpoPush(["ExpoPushToken[test]"], { title: "t", body: "b", expiration: 12345 });
  assert.equal(calls, 2);
  assert.equal(result.ticketId, "recovered");
});

test("bad credentials are reported without retry", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { ok: false, status: 401 }; });
  const [result] = await sendExpoPush(["ExpoPushToken[test]"], { title: "t", body: "b" });
  assert.equal(calls, 1);
  assert.equal(result.status, "error");
  assert.equal(result.error, "Expo push HTTP 401");
});

test("an ok response without a ticket id is never treated as accepted", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => ({ data: [{ status: "ok" }] }) }));
  const [result] = await sendExpoPush(["ExpoPushToken[test]"], { title: "t", body: "b" });
  assert.equal(result.status, "error");
  assert.equal(result.error, "no ticket id returned");
});
