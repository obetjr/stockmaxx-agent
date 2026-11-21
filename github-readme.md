# StockMaxx Agent

**A guardrailed autonomous agent that manages a basket of tokenized stocks on Base.**

Built by **Kantor Ogut** for Base's **Stocks Maxxing Season** — Track: **Agentic Stock Finance**.

> ⚠️ **Demo disclosure:** this repository is a Base Sepolia **testnet** demo. Every
> asset in it is **simulated** (mock tokens named mAAPL, mTSLA, …), every price is a
> **fixture**, and nothing here is a real stock, a real market, or financial advice.
> The mock tokens confer **no rights of any kind** in any real company. This project
> is not affiliated with or endorsed by Base, Coinbase, or any issuer.

## The story

Stock agents are coming to onchain finance — but an agent with an open wallet is a
liability. One bad prompt, one compromised key, one hallucinated price, and the
funds are gone.

StockMaxx flips the trust model: **the agent proposes, the contract enforces.**
The strategy lives off-chain, where it can evolve. The *guardrails* live on-chain,
where they cannot be talked out of existence. The agent gets a mandate, not the
keys: it can rebalance a defined basket inside hard limits, and it can **never**
withdraw funds or change its own rules.

## How it works

Every rebalance follows the same auditable loop:

1. **Decide** — the agent reads reference prices and computes an equal-weight
   target allocation for the basket.
2. **Commit** — before it may trade, the agent must log its decision *on-chain*
   (`logDecision`, with a human-readable reason). No log, no trades.
3. **Execute** — trades go through the vault, which enforces the guardrails on
   every single swap.

## On-chain guardrails (`AgenticStockVault`)

| Guardrail | Enforcement |
|---|---|
| Token allowlist | Agent can only trade owner-approved basket tokens |
| Decision log | No trades without a prior on-chain `DecisionLogged` event in the open cycle |
| Cycle interval | New cycles at most once per `minCycleInterval` (contract default 1h) |
| Trade cap | One trade ≤ `maxTradeBps` of vault NAV (default 25%) |
| Cycle window | Trades expire `cycleWindow` after the decision (default 1h) |
| Custody | Agent can **never** withdraw funds or change configuration — owner-only |

## Architecture

| Piece | File | Role |
|---|---|---|
| `AgenticStockVault` | `contracts/AgenticStockVault.sol` | Guardrailed vault + decision log + execution |
| `MockExchange` | `contracts/MockExchange.sol` | Simulated swap venue pricing off the oracle |
| `PriceOracle` | `contracts/PriceOracle.sol` | Reference prices (production role: Base Tokenized Stocks API) |
| `MockToken` | `contracts/MockToken.sol` | Simulated settlement (mUSDC) and stock tokens |
| Allocation engine | `agent/allocation.js` | Pure, tested equal-weight planner that mirrors the guardrails off-chain |
| Agent runner | `agent/runner.js` | Dry-run planner + live Base Sepolia execution (`--onchain`) |

## Live deployment — Base Sepolia (chain 84532, deployed 2026-11-19)

The full stack is **live on Base Sepolia** and the agent has already run real
rebalance cycles against it. Verify everything yourself on the explorer:
https://sepolia.basescan.org

| Contract | Address |
|---|---|
| **AgenticStockVault** | [`0xb5E3EC2d5277b4a2836BBE8691950137Ab2a823E`](https://sepolia.basescan.org/address/0xb5E3EC2d5277b4a2836BBE8691950137Ab2a823E) |
| MockExchange | [`0x45958AE072475b13708E7f9CDd800B4a97371DB0`](https://sepolia.basescan.org/address/0x45958AE072475b13708E7f9CDd800B4a97371DB0) |
| PriceOracle | [`0x99EE9d2937fC06A30a81c46EAF9C45Da2E901b68`](https://sepolia.basescan.org/address/0x99EE9d2937fC06A30a81c46EAF9C45Da2E901b68) |
| mUSDC (settlement) | [`0x6eDEd255B3b35B964d3de60cF712827D775fA0A2`](https://sepolia.basescan.org/address/0x6eDEd255B3b35B964d3de60cF712827D775fA0A2) |
| mAAPL | [`0xB1db285FCfE9bb3e4761CE37fCb52E8F98cd46A4`](https://sepolia.basescan.org/address/0xB1db285FCfE9bb3e4761CE37fCb52E8F98cd46A4) |
| mTSLA | [`0x7722c60f46eDF147288fa6164377B6b049710690`](https://sepolia.basescan.org/address/0x7722c60f46eDF147288fa6164377B6b049710690) |
| mNVDA | [`0x10B4BBF73C7B2e4be0dD6De9299362A88C8D40Da`](https://sepolia.basescan.org/address/0x10B4BBF73C7B2e4be0dD6De9299362A88C8D40Da) |
| mMSFT | [`0x61512Eef99a2e1BDf21763E2cbbC4cB662b631A5`](https://sepolia.basescan.org/address/0x61512Eef99a2e1BDf21763E2cbbC4cB662b631A5) |

## Live results so far

- **94 confirmed transactions** on Base Sepolia — 26 deployment/setup,
  40 cycle transactions (8 on-chain decisions + 32 trades), and 28 oracle
  price updates. Every receipt verified (status 1) via the public Base
  Sepolia RPC.
- **8 full live agent cycles** — each one a `DecisionLogged` commit followed
  by guardrail-checked `TradeExecuted` swaps; every cycle after the first
  responded to a fresh simulated price-move set in the oracle.
- **NAV: $10,000 → $10,617.87** — the vault was funded with 10,000 mUSDC and
  the agent's equal-weight rebalancing grew it through the simulated moves.
- Example decision transactions: cycle 1
  [`0x577f63e1…4dc6`](https://sepolia.basescan.org/tx/0x577f63e1cac096f64c61a738022fe14158ab53bf8b9797ba14f87443e8234dc6),
  cycle 8
  [`0xfca1cee3…1f9`](https://sepolia.basescan.org/tx/0xfca1cee3987718ce997606bac57a122901a797a40f3225ec9f721da41811f1f9).
  Open the vault address above and look for the `DecisionLogged` and
  `TradeExecuted` events to audit any cycle end-to-end.

## Honest demo tuning

One parameter differs from the contract default on this deployment: the
vault's `minCycleInterval` is set to **120 seconds** on-chain (contract
default: 1 hour) so that several full cycles fit inside one demo session.
The interval is still enforced by the vault — cycles simply open more
frequently. Everything else keeps its default: the **25%-of-NAV per-trade
cap** and the **1-hour cycle window** are untouched, and the agent's
no-withdrawal custody split is exactly as deployed in the contract.

## How to run

```bash
npm install          # solc-js + ethers (free, local)
npm test             # allocation engine tests (6 tests)
npm run compile      # compile all contracts to build/
npm run dry-run      # print a full rebalance decision + plan, no chain writes
npm run deploy       # deploy the stack to Base Sepolia (testnet signer required)
npm run onchain      # run ONE live agent cycle against the deployed vault
```

## Competition notes

- **Event:** Base Stocks Maxxing Season (Coinbase / Base) — prizes of
  $100,000+ total in USDC across tracks, plus a $6,000 best build-in-public
  prize.
- **Track:** Agentic Stock Finance · Quest period Nov 5 – Dec 5, 2026 (UTC).
- **Judging (per the Quest Page):** 50% real onchain usage, 25% product
  quality, 25% build-in-public.
- **Testnet submissions are explicitly allowed** and not judged less
  favorably (Official Rules §5). No token launch required. No purchase
  necessary.
