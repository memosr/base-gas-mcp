import http from "node:http";

// A stand-in for the base-gas-x402 API. Paid routes answer an unpaid request
// with a real-shaped x402 v2 challenge and a paid one with data plus a receipt.
// The payment itself is not verified: these tests cover the client side.
export const PRICES = { "/gas": "2000", "/gas/compare": "10000", "/gas/history": "10000", "/gas/cheapest-window": "20000" };

const BODIES = {
  "/gas": {
    baseFeePerGas: "0.005",
    priorityFeePerGas: { low: "0.0004", medium: "0.001", high: "0.007" },
    estimatedTransferCost: { gasLimit: 21000, gwei: "126", eth: "0.000000126", usd: "0.0003007" },
    suggestedFees: { unit: "wei", medium: { maxFeePerGas: "11000000", maxPriorityFeePerGas: "1000000" } },
  },
  "/gas/compare": {
    gasLimit: 21000,
    cheapest: "optimism",
    chains: [
      { label: "OP Mainnet", estimatedCost: { usd: "0.00005069" } },
      { label: "Base", estimatedCost: { usd: "0.0003007" } },
    ],
  },
  "/gas/history": { requestedHours: 24, verdict: "cheap", verdictNote: "Current price sits at 0% of the window's range." },
  "/gas/cheapest-window": { recommendation: "Avoid 02:00 UTC. The cheapest hour is 04:00 UTC." },
};

export async function startFakeApi({ prices = PRICES } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    seen.push({ path: url.pathname, query: url.search, paid: Boolean(req.headers["payment-signature"] || req.headers["x-payment"]) });
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/health") {
      return res.end(JSON.stringify({ status: "ok", history: { samples: 2016, hoursCovered: 168, durable: true } }));
    }
    const amount = prices[url.pathname];
    if (!amount) {
      res.statusCode = 404;
      return res.end("{}");
    }
    if (!req.headers["payment-signature"] && !req.headers["x-payment"]) {
      const challenge = {
        x402Version: 2,
        error: "Payment required",
        resource: { url: `http://${req.headers.host}${url.pathname}`, mimeType: "application/json" },
        accepts: [{
          scheme: "exact", network: "eip155:8453", amount,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0D083590c048A243e24a75E3a7C968145DE25B44",
          maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" },
        }],
      };
      res.statusCode = 402;
      res.setHeader("payment-required", Buffer.from(JSON.stringify(challenge)).toString("base64"));
      return res.end("{}");
    }
    const receipt = { success: true, transaction: "0xabc123", network: "eip155:8453", payer: "0x0" };
    res.setHeader("payment-response", Buffer.from(JSON.stringify(receipt)).toString("base64"));
    res.end(JSON.stringify(BODIES[url.pathname]));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}
