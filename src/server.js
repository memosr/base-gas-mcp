import "dotenv/config";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

// --- Constants ---------------------------------------------------------------

const DEFAULT_TARGET_URL = "https://base-gas-x402-production.up.railway.app/gas";
// Base mainnet, CAIP-2 network id used by the x402 client registry.
const NETWORK = "eip155:8453";
const PAYMENT_AMOUNT = "$0.001 USDC";

// --- Helpers -----------------------------------------------------------------

/**
 * Normalizes the buyer private key from the environment.
 * Returns a 0x-prefixed key or throws a user-facing error. The key value is
 * never logged or returned anywhere.
 * @returns {`0x${string}`}
 */
function readBuyerKey() {
  const raw = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error(
      "BUYER_PRIVATE_KEY is not set. Add a funded Base mainnet wallet private key to your .env before calling this tool. Each call spends real USDC.",
    );
  }
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "BUYER_PRIVATE_KEY is malformed. It must be a 32-byte hex private key (64 hex chars, optional 0x prefix).",
    );
  }
  return /** @type {`0x${string}`} */ (key);
}

/**
 * Builds a payment-enabled fetch bound to a funded buyer account on Base mainnet.
 * @param {`0x${string}`} privateKey
 */
function createPayingFetch(privateKey) {
  const account = privateKeyToAccount(privateKey);
  // A viem LocalAccount already satisfies ClientEvmSigner (address + signTypedData),
  // which is all the exact (EIP-3009) scheme needs to authorize the transfer.
  const client = new x402Client().register(
    NETWORK,
    new ExactEvmScheme(account),
  );
  return { account, fetchWithPay: wrapFetchWithPayment(fetch, client) };
}

/**
 * Pulls a value from the first matching key in a flat object.
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/**
 * Formats the gas API JSON into a readable tool result. Unknown shapes fall
 * back to pretty-printed JSON so the caller still gets the live data.
 * @param {any} data
 * @param {string} url
 * @param {string} payerAddress
 */
function formatGas(data, url, payerAddress) {
  const lines = [
    "Live Base mainnet gas (paid via x402)",
    "=".repeat(40),
  ];

  const baseFee = pick(data, ["baseFee", "base_fee", "baseFeePerGas"]);
  const priority =
    pick(data, ["priority", "priorityFees", "priority_fees"]) ?? data;
  const low = pick(priority ?? {}, ["low", "slow", "safeLow"]);
  const medium = pick(priority ?? {}, ["medium", "standard", "average"]);
  const high = pick(priority ?? {}, ["high", "fast", "fastest"]);
  const ethTransfer = pick(data, [
    "ethTransfer",
    "eth_transfer",
    "ethTransferCost",
    "transferCost",
    "estimatedCost",
  ]);

  if (baseFee !== undefined) lines.push(`Base fee:        ${baseFee}`);
  if (low !== undefined) lines.push(`Priority (low):  ${low}`);
  if (medium !== undefined) lines.push(`Priority (med):  ${medium}`);
  if (high !== undefined) lines.push(`Priority (high): ${high}`);
  if (ethTransfer !== undefined) {
    const cost =
      typeof ethTransfer === "object"
        ? JSON.stringify(ethTransfer)
        : ethTransfer;
    lines.push(`ETH transfer:    ${cost}`);
  }

  // If we recognized nothing structured, show the raw payload.
  const recognized = [baseFee, low, medium, high, ethTransfer].some(
    (v) => v !== undefined,
  );
  if (!recognized) {
    lines.push("Raw response:");
    lines.push(JSON.stringify(data, null, 2));
  }

  lines.push("-".repeat(40));
  lines.push(`Source:  ${url}`);
  lines.push(`Payer:   ${payerAddress}`);
  lines.push(`Paid:    ${PAYMENT_AMOUNT} on Base mainnet (${NETWORK})`);
  return lines.join("\n");
}

/** Builds an MCP error tool result. */
function toolError(message) {
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

// --- Tool implementation -----------------------------------------------------

/**
 * @param {{ target_url?: string }} args
 */
async function getBaseGas(args) {
  const url =
    args?.target_url?.trim() ||
    process.env.TARGET_URL?.trim() ||
    DEFAULT_TARGET_URL;

  let payer;
  try {
    const privateKey = readBuyerKey();
    const { account, fetchWithPay } = createPayingFetch(privateKey);
    payer = account.address;

    const res = await fetchWithPay(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return toolError(
        `Gas endpoint returned HTTP ${res.status} ${res.statusText}. ` +
          (res.status === 402
            ? "Payment was not accepted — check that the buyer wallet holds USDC and ETH on Base mainnet. "
            : "") +
          (body ? `Body: ${body.slice(0, 300)}` : ""),
      );
    }

    const data = await res.json();
    return { content: [{ type: "text", text: formatGas(data, url, payer) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Common failure modes surfaced clearly; never echo the private key.
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(message)) {
      return toolError(
        `Could not reach the gas endpoint (${url}). It may be down or unreachable: ${message}`,
      );
    }
    if (/insufficient|balance|funds/i.test(message)) {
      return toolError(
        `Payment failed — the buyer wallet likely lacks USDC/ETH on Base mainnet: ${message}`,
      );
    }
    return toolError(message);
  }
}

// --- Server bootstrap --------------------------------------------------------

const server = new McpServer({
  name: "base-gas-mcp",
  version: "1.0.0",
});

server.registerTool(
  "get_base_gas",
  {
    title: "Get live Base mainnet gas",
    description:
      "Returns live Base mainnet gas data (base fee, low/medium/high priority fees, " +
      "and an ETH transfer cost estimate). IMPORTANT: every call makes a REAL " +
      `${PAYMENT_AMOUNT} payment on Base mainnet via the x402 protocol and requires a ` +
      "funded buyer wallet (BUYER_PRIVATE_KEY) holding USDC and ETH for gas. " +
      "Do not call this repeatedly or in loops — each invocation spends real money.",
    inputSchema: {
      target_url: z
        .string()
        .url()
        .optional()
        .describe(
          "Optional override for the x402 gas API URL. Defaults to the live Base gas endpoint.",
        ),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  getBaseGas,
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they never corrupt the stdio JSON-RPC stream.
  console.error("base-gas-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
