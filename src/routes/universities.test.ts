import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app";

const app = createApp();

test("public university search expands a partial word and returns a ROR identity", async (t) => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const query = new URL(url).searchParams.get("query");
    const items = query?.endsWith("*") ? [{
      id: "https://ror.org/02en5vm52",
      status: "active",
      types: ["education"],
      names: [
        { value: "Sorbonne Université", types: ["ror_display", "label"] },
        { value: "Sorbonne University", types: ["alias"] },
      ],
      locations: [{ geonames_details: { name: "Paris", country_name: "France" } }],
    }] : [];
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });

  const res = await request(app).get("/api/universities?q=sorbon");
  assert.equal(res.status, 200);
  assert.equal(new URL(urls[0]).searchParams.get("filter"), "types:education");
  assert.equal(new URL(urls[1]).searchParams.get("query"), "sorbon*");
  assert.deepEqual(res.body.items, [{
    id: "https://ror.org/02en5vm52", n: "Sorbonne Université", c: "France", city: "Paris",
  }]);
});

test("university search rejects an unbounded query before calling ROR", async () => {
  const res = await request(app).get(`/api/universities?q=${"a".repeat(81)}`);
  assert.equal(res.status, 400);
});

test("a misspelling before a generic word still finds the university", async (t) => {
  const original = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = async (input) => {
    const query = new URL(String(input)).searchParams.get("query")!;
    queries.push(query);
    const name = query.includes("~1") ? "Sorbonne Université" : "Rivier University";
    return new Response(JSON.stringify({ items: [{
      id: query.includes("~1") ? "https://ror.org/02en5vm52" : "https://ror.org/000000000",
      status: "active", types: ["education"],
      names: [{ value: name, types: ["ror_display"] }],
      locations: [{ geonames_details: { name: "Paris", country_name: "France" } }],
    }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  const res = await request(app).get("/api/universities?q=Sorbomne%20Universit%C3%A9");
  assert.equal(res.status, 200);
  assert.ok(queries.includes("Sorbomne~1 Université"));
  assert.equal(res.body.items[0].n, "Sorbonne Université");
});
