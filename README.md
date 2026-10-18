# base-gas-mcp

<!-- mcp-name: io.github.memosr/base-gas-mcp -->

An MCP server for live Base gas data, paid per call in USDC over the
[x402](https://www.x402.org) payment protocol. No API key and no account: the
agent pays a fraction of a cent from a wallet you control.

It answers the questions an RPC call cannot: what a transaction costs **in
dollars**, which chain is cheapest right now, whether gas is high or low, and
which hours to avoid.

## Tools

| Tool | Price | What it returns |
|------|-------|-----------------|
| `get_base_gas` | ~$0.002 | Base fee, low/medium/high priority fees, and the cost of a transaction in USD, ETH and gwei. Optional `gasLimit`. |
| `compare_gas_costs` | ~$0.01 | The same transaction on Base, OP Mainnet, Arbitrum One and Ethereum, in USD, cheapest first. Optional `gasLimit`. |
| `get_gas_history` | ~$0.01 | Base gas over the last `hours` (default 24): min/max/average/median and whether gas is cheap, normal, expensive or flat now. |
| `get_cheapest_window` | ~$0.02 | From 7 days of history: hours to avoid, cheapest hour (UTC), and the saving in percent and USD. |
| `get_service_status` | free | Whether the service is up and how much history it has collected. Needs no wallet. |

Prices are set by the endpoint and published in its
[OpenAPI document](https://base-gas-x402-production.up.railway.app/openapi.json).
Every paid result includes the settlement transaction hash.

`gasLimit` guide: 21000 ETH transfer (default), ~65000 ERC-20 transfer, ~85000
NFT mint, ~180000 Uniswap swap, ~1500000 contract deploy.

## Safety

- **The server only ever pays one origin**, set by you (`BASE_GAS_ORIGIN`,
  defaulting to the live base-gas-x402 API). No tool takes a URL, so text the
  model reads cannot redirect your wallet to another paid endpoint.
- **Per-payment cap.** Any payment above `MAX_USD_PER_CALL` (default `0.05`) is
  refused before anything is signed.
- Payments are EIP-3009 authorizations: the wallet needs **USDC only, no ETH**.
- Use a separate wallet holding a few dollars. The key is read from the
  environment to sign payments and is never logged or returned.

The paid data source is a companion project:
[base-gas-x402](https://github.com/memosr/base-gas-x402).

## Installation

**Requirements**

- Node.js 18 or newer (built-in `fetch` is required)
- A Base mainnet wallet holding a little USDC (no ETH needed)

```bash
git clone https://github.com/memosr/base-gas-mcp.git
cd base-gas-mcp
npm install
```

Pass `BUYER_PRIVATE_KEY` through your MCP client's config (see below). The server does not read a `.env` file.

Or run the published package directly with `npx base-gas-mcp` (see the config blocks below).

### Getting a buyer key

`BUYER_PRIVATE_KEY` is the private key of a Base mainnet wallet. Create a fresh wallet (for example in MetaMask, Coinbase Wallet, or with `cast wallet new`), export its private key, and fund it on Base with a few dollars of USDC.

> **Warning:** this is a real private key that controls real funds.
> Use a separate, disposable wallet holding only small amounts. Never reuse a key from a wallet with significant funds, never commit it to git, and never paste it into chat. The server reads it only to sign payments and never logs or returns it.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BUYER_PRIVATE_KEY` | Yes | 32-byte hex private key (64 hex chars, `0x` prefix optional) of a funded Base mainnet wallet. |
| `MAX_USD_PER_CALL` | No | Refuse any single payment above this many USD. Default `0.05`. |
| `BASE_GAS_ORIGIN` | No | The only origin the server pays. Defaults to `https://base-gas-x402-production.up.railway.app`. |
| `BUILDER_CODE` | No | Base Builder Code attached to the payment payload for attribution. Defaults to `bc_lhfd8zad`. |

## Configuration

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "base-gas": {
      "command": "npx",
      "args": ["-y", "base-gas-mcp"],
      "env": {
        "BUYER_PRIVATE_KEY": "0xYOUR_FUNDED_BASE_MAINNET_PRIVATE_KEY"
      }
    }
  }
}
```

To run from a local clone instead, point `command` at Node and use the absolute path to the server:

```json
{
  "mcpServers": {
    "base-gas": {
      "command": "node",
      "args": ["/absolute/path/to/base-gas-mcp/src/server.js"],
      "env": {
        "BUYER_PRIVATE_KEY": "0xYOUR_FUNDED_BASE_MAINNET_PRIVATE_KEY"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add base-gas \
  --env BUYER_PRIVATE_KEY=0xYOUR_FUNDED_BASE_MAINNET_PRIVATE_KEY \
  -- npx -y base-gas-mcp
```

Or from a local clone:

```bash
claude mcp add base-gas \
  --env BUYER_PRIVATE_KEY=0xYOUR_FUNDED_BASE_MAINNET_PRIVATE_KEY \
  -- node /absolute/path/to/base-gas-mcp/src/server.js
```

The server reads its settings only from the environment the client passes. It does not load a `.env` file (since 0.3.1), so a `.env` in whatever folder the client opens cannot change where the wallet pays.

## Example usage

Once configured, ask your agent:

- "What does a Uniswap swap on Base cost right now, in dollars?" (`get_base_gas` with `gasLimit` 180000)
- "Is Base or Arbitrum cheaper for a token transfer at the moment?" (`compare_gas_costs`)
- "Is Base gas high right now, or should I wait?" (`get_gas_history`)
- "When should I schedule a batch of transactions on Base?" (`get_cheapest_window`)

Each of these is one paid call. Check `get_service_status` first for free.

## Tech stack

- Node.js (ESM), served over stdio transport
- [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) for the MCP server
- [`@x402/fetch`](https://www.x402.org), `@x402/evm`, and `@x402/extensions` for the payment-wrapped fetch, the EIP-3009 exact payment scheme, and builder-code attribution
- [`viem`](https://viem.sh) for account handling and signing
- [`zod`](https://zod.dev) for input validation

## License

[MIT](./LICENSE), copyright (c) 2026 memosr.
