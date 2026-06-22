# base-gas-mcp

A single-tool [MCP](https://modelcontextprotocol.io) server that lets an AI agent **buy data with x402**. Its `get_base_gas` tool fetches live Base mainnet gas, paying **$0.001 USDC per call** to a companion API — a working demo of pay-per-call data access for agents.

## How it works

```
Agent ──calls──▶ get_base_gas tool
                      │
                      │ @x402/fetch pays $0.001 USDC
                      │ (Base mainnet, eip155:8453)
                      ▼
              Companion x402 gas API ──▶ live gas JSON
```

1. The agent invokes `get_base_gas`.
2. The tool issues a paid request with [`@x402/fetch`](https://www.x402.org). The companion API answers an unpaid request with HTTP `402 Payment Required`; the x402 client signs an EIP-3009 authorization for a **$0.001 USDC** transfer on **Base mainnet** (CAIP-2 network `eip155:8453`) and retries.
3. The API returns live gas data as JSON, which the tool formats and returns to the agent.

The companion API is a separate project: **[base-gas-x402](https://github.com/memosr/base-gas-x402)** (live endpoint: `https://base-gas-x402-production.up.railway.app/gas`).

## Tool reference

### `get_base_gas`

Returns live Base mainnet gas data.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `target_url` | string (URL) | No | Override the x402 gas API URL. Defaults to the live Base gas endpoint. |

**Returned fields** (fees in gwei)

| Field | Description |
|-------|-------------|
| `baseFee` | Current base fee |
| `priority` (low / medium / high) | Priority fee tiers |
| `gasPrice` | Effective gas price |
| `estimatedTransferCost` | Estimated cost of a plain ETH transfer |
| `fetchedAt` | Timestamp of the reading |

> ### ⚠️ WARNING — every call spends real money
> Each `get_base_gas` invocation makes a **real $0.001 USDC payment** on Base mainnet and requires a funded buyer wallet (`BUYER_PRIVATE_KEY`) holding USDC plus a little ETH for gas. **Do not call it in loops or on a polling schedule** — every invocation spends real funds.

## Installation

```bash
npm install
cp .env.example .env
# edit .env and set BUYER_PRIVATE_KEY to a funded Base mainnet wallet key
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BUYER_PRIVATE_KEY` | Yes | Private key of a **funded Base mainnet wallet**. Needs a small USDC balance to pay per call and a little ETH for gas. 32-byte hex (64 hex chars, `0x` prefix optional). |
| `TARGET_URL` | No | Override the gas API URL. Defaults to the live Base gas endpoint. |

`.env` is gitignored — never commit it.

## Adding to Claude Code

```bash
claude mcp add base-gas-mcp -- node ~/base-gas-mcp/src/server.js
```

## Adding to Claude Desktop

Add the server to your `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), using an
absolute path to `server.js`:

```json
{
  "mcpServers": {
    "base-gas-mcp": {
      "command": "node",
      "args": ["/Users/you/base-gas-mcp/src/server.js"],
      "env": {
        "BUYER_PRIVATE_KEY": "0xyour_funded_base_mainnet_key"
      }
    }
  }
}
```

Restart the client after editing the config.

## Security

- `BUYER_PRIVATE_KEY` is **never logged or returned** by the server, and `.env` is in `.gitignore` — never commit it.
- Use a **separate, disposable wallet** funded with only a small amount of USDC and ETH. Treat it as a hot wallet that may be exposed; do not reuse a key that holds significant funds.
- The server reads the key only at call time to sign the x402 payment authorization.

## Tech stack

- [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) — MCP server, served over **stdio** transport
- [`@x402/fetch`](https://www.x402.org) + [`@x402/evm`](https://www.x402.org) — x402 payment-wrapped `fetch` and the EVM exact (EIP-3009) payment scheme
- [`viem`](https://viem.sh) — local account / signing
- Node.js (ESM)

## What is x402?

x402 is an open payment standard built on the HTTP `402 Payment Required` status code. A server can demand a small on-chain payment (here, USDC on Base) before returning a response, and an x402-aware client pays and retries automatically — enabling frictionless, pay-per-call APIs for agents and machines. Learn more at [x402.org](https://www.x402.org).

## License

[MIT](./LICENSE)
