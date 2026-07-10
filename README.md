# base-gas-mcp

An MCP server that fetches live Base mainnet gas data by paying $0.001 USDC per call over the [x402](https://www.x402.org) payment protocol.

## Tools

### `get_base_gas`

Fetches live Base mainnet gas data from a paid x402 API. Each call makes a real $0.001 USDC payment on Base mainnet (`eip155:8453`), signed as an EIP-3009 transfer authorization by the wallet in `BUYER_PRIVATE_KEY`. Do not call it in loops or on a schedule: every invocation spends real funds.

**Parameters**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `target_url` | string (URL) | No | Override the x402 gas API URL. Defaults to `https://base-gas-x402-production.up.railway.app/gas`. |

**Returns** a formatted text report with:

- Base fee
- Priority fees (low, medium, high)
- Estimated ETH transfer cost
- Source URL, payer address, and the amount paid

Example call from an MCP client:

```json
{
  "name": "get_base_gas",
  "arguments": {}
}
```

The paid data source is a companion project: [base-gas-x402](https://github.com/memosr/base-gas-x402).

## Installation

**Requirements**

- Node.js 18 or newer (built-in `fetch` is required)
- A funded Base mainnet wallet: a small USDC balance to pay per call, plus a little ETH for gas

```bash
git clone https://github.com/memosr/base-gas-mcp.git
cd base-gas-mcp
npm install
cp .env.example .env
# edit .env and set BUYER_PRIVATE_KEY
```

Or run the published package directly with `npx base-gas-mcp` (see the config blocks below).

### Getting a buyer key

`BUYER_PRIVATE_KEY` is the private key of a Base mainnet wallet. Create a fresh wallet (for example in MetaMask, Coinbase Wallet, or with `cast wallet new`), export its private key, and fund it on Base with a few dollars of USDC and a small amount of ETH.

> **Warning:** this is a real private key that controls real funds.
> Use a separate, disposable wallet holding only small amounts. Never reuse a key from a wallet with significant funds, never commit it to git (`.env` is gitignored), and never paste it into chat. The server reads it only to sign payments and never logs or returns it.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BUYER_PRIVATE_KEY` | Yes | 32-byte hex private key (64 hex chars, `0x` prefix optional) of a funded Base mainnet wallet. |
| `TARGET_URL` | No | Override the gas API URL. |
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
claude mcp add base-gas -- node /absolute/path/to/base-gas-mcp/src/server.js
```

With the local form, put `BUYER_PRIVATE_KEY` in the project's `.env` file instead of the command line.

## Example usage

Once configured, ask Claude:

- "What is the current gas price on Base?"
- "How much would a simple ETH transfer cost on Base right now?"
- "Check Base gas and tell me whether the base fee is high or low at the moment."

Each of these triggers one `get_base_gas` call and spends $0.001 USDC.

## Tech stack

- Node.js (ESM), served over stdio transport
- [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) for the MCP server
- [`@x402/fetch`](https://www.x402.org), `@x402/evm`, and `@x402/extensions` for the payment-wrapped fetch, the EIP-3009 exact payment scheme, and builder-code attribution
- [`viem`](https://viem.sh) for account handling and signing
- [`zod`](https://zod.dev) for input validation

## License

[MIT](./LICENSE), copyright (c) 2026 memosr.
