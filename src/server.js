#!/usr/bin/env node
// Configuration comes only from the environment the MCP client sets. No .env
// loading: the server starts in whatever directory the client was opened in,
// and a .env there (e.g. in a cloned repo) could repoint BASE_GAS_ORIGIN and
// raise MAX_USD_PER_CALL for the wallet.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";
import { privateKeyToAccount } from "viem/accounts";

// --- Configuration -------------------------------------------------------------

// The only origin this server will ever pay. It is fixed by the operator, never
// chosen by the model: a tool argument that picked the URL would let injected
// text steer the wallet to an arbitrary paid endpoint.
const ORIGIN = (process.env.BASE_GAS_ORIGIN || "https://base-gas-x402-production.up.railway.app").replace(/\/+$/, "");

// Base mainnet, CAIP-2 id used by the x402 client registry.
const NETWORK = "eip155:8453";

// Hard cap per payment. The routes cost $0.002 to $0.02; anything above the cap
// is refused before a signature is made. Raise it with MAX_USD_PER_CALL.
const MAX_USD_PER_CALL = (() => {
  const raw = process.env.MAX_USD_PER_CALL?.trim() || "0.05";
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`MAX_USD_PER_CALL must be a positive number, got "${raw}"`);
  }
  return raw;
})();

// Base Builder Code attached to payments for attribution (same as the server's).
const BUILDER_CODE_VALUE = process.env.BUILDER_CODE || "bc_lhfd8zad";

const MIN_GAS_LIMIT = 21000;
const MAX_GAS_LIMIT = 30000000;
const MAX_HOURS = 168;

// --- Payments -------------------------------------------------------------------

/**
 * Reads the buyer key. Never logged or returned.
 * @returns {`0x${string}`}
 */
function readBuyerKey() {
  const raw = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error(
      "BUYER_PRIVATE_KEY is not set. Configure a funded Base mainnet wallet (USDC only, no ETH needed) to use the paid tools. get_service_status works without it.",
    );
  }
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("BUYER_PRIVATE_KEY is malformed. Expected 32 bytes of hex (64 chars, optional 0x prefix).");
  }
  return /** @type {`0x${string}`} */ (key);
}

let paying = null;

/** Builds the paying fetch once, on first use, so free tools never need a key. */
function getPayingFetch() {
  if (paying) return paying;
  const account = privateKeyToAccount(readBuyerKey());
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(account))
    // Refuse any payment above the cap before signing anything.
    .setSpendControls({ maxAmountPerPayment: `$${MAX_USD_PER_CALL}` });
  client.registerExtension(new BuilderCodeClientExtension(BUILDER_CODE_VALUE));
  paying = { account, fetchWithPay: wrapFetchWithPayment(fetch, client) };
  return paying;
}

/** Settlement receipt: PAYMENT-RESPONSE on x402 v2 servers, X-PAYMENT-RESPONSE on v1. */
function readReceipt(response) {
  const header = response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return null;
  }
}

function toolError(message) {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

function explain(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(message)) {
    return `Could not reach ${ORIGIN}: ${message}`;
  }
  if (/spend|exceed|max.*amount|cap/i.test(message)) {
    return `Payment refused: the endpoint asked for more than the $${MAX_USD_PER_CALL} per-call cap (MAX_USD_PER_CALL). ${message}`;
  }
  if (/insufficient|balance|funds/i.test(message)) {
    return `Payment failed, the buyer wallet likely lacks USDC on Base mainnet: ${message}`;
  }
  return message;
}

/**
 * Calls one of the service's routes. Paid routes go through x402; the free
 * status route uses plain fetch and needs no key.
 * @param {string} path Route path with query string, under ORIGIN.
 * @param {(data: any) => string} summarize One-paragraph human summary.
 * @param {{ paid: boolean }} options
 */
async function callRoute(path, summarize, { paid }) {
  const url = `${ORIGIN}${path}`;
  try {
    const { account, fetchWithPay } = paid ? getPayingFetch() : { account: null, fetchWithPay: fetch };
    const res = await fetchWithPay(url, { method: "GET", headers: { Accept: "application/json" } });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return toolError(
        `${url} returned HTTP ${res.status}.` +
          (res.status === 402 ? " Payment was not accepted; check that the wallet holds USDC on Base mainnet." : "") +
          (res.status === 429 ? " Rate limited; nothing was charged, retry after a minute." : "") +
          (body ? ` Body: ${body.slice(0, 300)}` : ""),
      );
    }

    const data = await res.json();
    const lines = [summarize(data)];
    if (paid) {
      const receipt = readReceipt(res);
      lines.push(
        receipt?.transaction
          ? `Paid in USDC on Base from ${account.address}, tx ${receipt.transaction}.`
          : `Paid in USDC on Base from ${account.address}.`,
      );
    }
    lines.push("", "Full response:", JSON.stringify(data, null, 2));
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return toolError(explain(err));
  }
}

const usd = (v) => (v === null || v === undefined ? "n/a" : `$${v}`);

// --- Tools ----------------------------------------------------------------------

const server = new McpServer({ name: "base-gas-mcp", version: "0.3.2" });

const PAID_NOTE =
  "Each call makes a real USDC micropayment on Base mainnet via x402 from BUYER_PRIVATE_KEY; " +
  "payments above MAX_USD_PER_CALL are refused. Do not call it in loops.";

const gasLimit = z
  .number()
  .int()
  .min(MIN_GAS_LIMIT)
  .max(MAX_GAS_LIMIT)
  .optional()
  .describe("Gas units to price. 21000 ETH transfer (default), ~65000 ERC-20 transfer, ~85000 NFT mint, ~180000 Uniswap swap, ~1500000 contract deploy.");

const hours = z.number().int().min(1).max(MAX_HOURS).optional();

server.registerTool(
  "get_base_gas",
  {
    title: "Live Base gas and transaction cost",
    description: `Live Base mainnet gas: EIP-1559 base fee, low/medium/high priority fees in gwei, the cost of a transaction in USD, ETH and gwei, and ready-to-sign maxFeePerGas / maxPriorityFeePerGas. Costs about $0.002. ${PAID_NOTE}`,
    inputSchema: { gasLimit },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ gasLimit: g }) =>
    callRoute(`/gas${g ? `?gasLimit=${g}` : ""}`, (d) => {
      const c = d.estimatedTransferCost ?? {};
      const m = d.suggestedFees?.medium;
      const fees = m
        ? ` To send now: maxFeePerGas ${m.maxFeePerGas} wei, maxPriorityFeePerGas ${m.maxPriorityFeePerGas} wei (medium tier; maxFeePerGas is a ceiling, the unused part is refunded).`
        : "";
      return `Base gas: base fee ${d.baseFeePerGas} gwei, priority low/medium/high ${d.priorityFeePerGas?.low}/${d.priorityFeePerGas?.medium}/${d.priorityFeePerGas?.high} gwei. A ${c.gasLimit}-gas transaction costs about ${usd(c.usd)} (${c.eth} ETH).${fees}`;
    }, { paid: true }),
);

server.registerTool(
  "compare_gas_costs",
  {
    title: "Compare gas costs across Base, OP, Arbitrum and Ethereum",
    description: `Live cost of the same transaction on Base, OP Mainnet, Arbitrum One and Ethereum, in USD and ETH, ranked cheapest first. Costs about $0.01. ${PAID_NOTE}`,
    inputSchema: { gasLimit },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ gasLimit: g }) =>
    callRoute(`/gas/compare${g ? `?gasLimit=${g}` : ""}`, (d) => {
      const ranking = (d.chains ?? []).map((c) => `${c.label} ${usd(c.estimatedCost?.usd)}`).join(", ");
      return `Cheapest right now: ${d.cheapest}. Ranking for ${d.gasLimit} gas: ${ranking}.`;
    }, { paid: true }),
);

server.registerTool(
  "get_gas_history",
  {
    title: "Base gas history and verdict",
    description: `Base gas sampled every 5 minutes over a lookback window (default 24h): min/max/average/median and whether gas is cheap, normal, expensive or flat right now. Costs about $0.01. ${PAID_NOTE}`,
    inputSchema: { hours: hours.describe("Lookback window in hours, 1 to 168. Default 24.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ hours: h }) =>
    callRoute(`/gas/history${h ? `?hours=${h}` : ""}`, (d) =>
      `Verdict for the last ${d.requestedHours}h: ${d.verdict}. ${d.verdictNote ?? ""}`.trim(),
    { paid: true }),
);

server.registerTool(
  "get_cheapest_window",
  {
    title: "When to transact on Base",
    description: `From 7 days of Base gas history: the hours of day to avoid, the cheapest hour (UTC), and the saving versus the average hour in percent and USD. Says so plainly when timing saves nothing. Costs about $0.02. ${PAID_NOTE}`,
    inputSchema: { hours: hours.describe("Lookback window in hours, 1 to 168. Default 168.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ hours: h }) =>
    callRoute(`/gas/cheapest-window${h ? `?hours=${h}` : ""}`, (d) => d.recommendation ?? "No recommendation returned.", { paid: true }),
);

server.registerTool(
  "get_service_status",
  {
    title: "Service status and history coverage (free)",
    description:
      "Free, no wallet needed. Reports whether the gas service is up and how much gas history it has collected, so you can decide whether the history tools are worth paying for.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () =>
    callRoute("/health", (d) => {
      const h = d.history ?? {};
      return `Status ${d.status}. History: ${h.samples} samples over ${h.hoursCovered}h, durable ${h.durable}.`;
    }, { paid: false }),
);

async function main() {
  await server.connect(new StdioServerTransport());
  // stderr only: stdout carries the JSON-RPC stream.
  console.error(`base-gas-mcp 0.3.2 on stdio, paying ${ORIGIN}, cap $${MAX_USD_PER_CALL} per call`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
