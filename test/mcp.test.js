import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";
import { startFakeApi } from "./fake-gas-api.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Drives the real MCP server over stdio, against a fake paid API.
let api, client;
const text = (r) => r.content.map((c) => c.text).join("\n");

async function connect(env) {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.js"],
      env: { PATH: process.env.PATH, BASE_GAS_ORIGIN: api.origin, ...env },
      stderr: "ignore",
    }),
  );
  return c;
}

before(async () => {
  api = await startFakeApi({
    // cheapest-window priced above the default $0.05 cap on purpose.
    prices: { "/gas": "2000", "/gas/compare": "10000", "/gas/history": "10000", "/gas/cheapest-window": "100000" },
  });
  client = await connect({ BUYER_PRIVATE_KEY: generatePrivateKey() });
});

after(async () => {
  await client?.close();
  api?.close();
});

test("lists the five tools, and none of them takes a URL", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["compare_gas_costs", "get_base_gas", "get_cheapest_window", "get_gas_history", "get_service_status"],
  );
  for (const t of tools) {
    assert.ok(!Object.keys(t.inputSchema.properties ?? {}).some((k) => /url/i.test(k)), t.name);
  }
});

test("get_base_gas pays, passes gasLimit, and reports USD and the tx", async () => {
  const r = await client.callTool({ name: "get_base_gas", arguments: { gasLimit: 180000 } });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /\$0\.0003007/);
  assert.match(text(r), /tx 0xabc123/);
  assert.match(text(r), /maxFeePerGas 11000000 wei, maxPriorityFeePerGas 1000000 wei/);
  assert.ok(api.seen.some((s) => s.path === "/gas" && s.query === "?gasLimit=180000" && s.paid));
});

test("compare_gas_costs summarizes the ranking", async () => {
  const r = await client.callTool({ name: "compare_gas_costs", arguments: {} });
  assert.match(text(r), /Cheapest right now: optimism/);
});

test("a payment above the cap is refused before anything is signed", async () => {
  const before = api.seen.filter((s) => s.path === "/gas/cheapest-window" && s.paid).length;
  const r = await client.callTool({ name: "get_cheapest_window", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /Payment refused|cap/i);
  const after = api.seen.filter((s) => s.path === "/gas/cheapest-window" && s.paid).length;
  assert.equal(after, before, "no paid request was sent");
});

test("rejects out-of-range arguments", async () => {
  const r = await client.callTool({ name: "get_gas_history", arguments: { hours: 1000 } });
  assert.equal(r.isError, true);
});

test("get_service_status works without a wallet", async () => {
  const c = await connect({ BUYER_PRIVATE_KEY: "" });
  try {
    const r = await c.callTool({ name: "get_service_status", arguments: {} });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /2016 samples/);
    const paid = await c.callTool({ name: "get_base_gas", arguments: {} });
    assert.equal(paid.isError, true);
    assert.match(text(paid), /BUYER_PRIVATE_KEY is not set/);
  } finally {
    await c.close();
  }
});

test("a .env in the working directory cannot repoint the wallet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "base-gas-mcp-"));
  writeFileSync(join(dir, ".env"), "BASE_GAS_ORIGIN=https://attacker.example\nMAX_USD_PER_CALL=1000\n");
  const child = spawn(process.execPath, [resolve("src/server.js")], { cwd: dir, env: { PATH: process.env.PATH } });
  const banner = await new Promise((done) => child.stderr.once("data", (d) => done(String(d))));
  child.kill();
  assert.match(banner, /paying https:\/\/base-gas-x402-production\.up\.railway\.app, cap \$0\.05/);
  assert.doesNotMatch(banner, /attacker/);
});
