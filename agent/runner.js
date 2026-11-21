'use strict';
/**
 * runner.js — StockMaxx agent runner.
 *
 * Modes:
 *   node agent/runner.js --dry-run [--portfolio portfolio.json]
 *       Reads simulated reference prices (prices.fixture.json) and a
 *       portfolio state, computes the equal-weight rebalance plan with
 *       allocation.js, prints the decision log exactly as it would be
 *       committed on-chain via AgenticStockVault.logDecision, and writes
 *       the plan to agent/last-plan.json. No network, no keys, no funds.
 *
 *   node agent/runner.js --onchain
 *       LIVE MODE (Base Sepolia only). Reads holdings + oracle prices
 *       from the deployed AgenticStockVault, plans with allocation.js,
 *       commits the decision on-chain via logDecision(reason), then runs
 *       executeTrade(...) per planned trade. Contract addresses come
 *       from runtime/deployment.json (VAULT_ADDRESS env overrides).
 *       The agent signer is the Kantor testnet burner, decrypted in
 *       memory from its vault keystore by scripts/wallet.js — the key is
 *       never printed or persisted (AGENT_KEY_FILE, a file containing a
 *       raw key, is accepted as an alternative but is NOT the default).
 *       The runner hard-refuses any chain other than Base Sepolia
 *       (84532) and must never be pointed at mainnet.
 */
const fs = require('fs');
const path = require('path');
const { planEqualWeight } = require('./allocation');

const DIR = __dirname;

function loadFixturePrices() {
  const fixture = JSON.parse(fs.readFileSync(path.join(DIR, 'prices.fixture.json'), 'utf8'));
  const prices = {};
  for (const s of fixture.stocks) prices[s.symbol] = s.priceUsd;
  return { prices, basket: fixture.stocks.map((s) => s.symbol), asOf: fixture.asOf };
}

function defaultPortfolio(basket) {
  // Demo starting state: all cash, nothing invested yet.
  const holdings = { SETTLEMENT: 10000 };
  for (const t of basket) holdings[t] = 0;
  return holdings;
}

function dryRun(portfolioPath) {
  const { prices, basket, asOf } = loadFixturePrices();
  const holdings = portfolioPath
    ? JSON.parse(fs.readFileSync(portfolioPath, 'utf8'))
    : defaultPortfolio(basket);

  const plan = planEqualWeight(holdings, prices, basket, {
    cashBufferBps: 1000,
    maxTradeBps: 2500,
    minTradeUsd: 5,
  });

  const reason =
    `cycle: equal-weight rebalance | NAV $${plan.nav} | target $${plan.targetPerToken}/token | ` +
    `${plan.trades.length} trades | prices as of ${asOf} (simulated)`;

  console.log('=== StockMaxx agent — DRY RUN (simulated prices, no chain writes) ===');
  console.log(`DECISION (would be committed via logDecision): ${reason}`);
  for (const n of plan.notes) console.log(`  note: ${n}`);
  if (plan.trades.length === 0) console.log('  no trades needed');
  for (const t of plan.trades) console.log(`  ${t.side} ${t.token}: $${t.usd}`);

  const out = { mode: 'dry-run', reason, holdings, prices, plan };
  fs.writeFileSync(path.join(DIR, 'last-plan.json'), JSON.stringify(out, null, 2));
  console.log('plan written to agent/last-plan.json');
  return out;
}

function loadDeployment() {
  const file = path.join(DIR, '..', 'runtime', 'deployment.json');
  if (!fs.existsSync(file)) {
    throw new Error('runtime/deployment.json not found — run `npm run deploy` first');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function onchain() {
  const { ethers } = require('ethers');
  const { loadSigner, assertBaseSepolia, getProvider } = require('../scripts/wallet');

  const deployment = loadDeployment();
  const provider = getProvider();
  await assertBaseSepolia(provider); // hard-refuses mainnet / any other chain

  let signer;
  if (process.env.AGENT_KEY_FILE) {
    const key = fs.readFileSync(process.env.AGENT_KEY_FILE, 'utf8').trim();
    signer = new ethers.Wallet(key, provider);
  } else {
    signer = await loadSigner(provider); // vault keystore, decrypted in memory only
  }

  const vaultAddress = process.env.VAULT_ADDRESS || deployment.contracts.vault;
  const artifact = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'build', 'AgenticStockVault.json'), 'utf8'));
  const tokenArtifact = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'build', 'MockToken.json'), 'utf8'));
  const oracleArtifact = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'build', 'PriceOracle.json'), 'utf8'));
  const vault = new ethers.Contract(vaultAddress, artifact.abi, signer);
  const oracle = new ethers.Contract(deployment.contracts.oracle, oracleArtifact.abi, provider);

  const agent = await vault.agent();
  if (agent.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`signer ${signer.address} is not the vault agent (${agent}) — refusing`);
  }

  // --- Read live state -----------------------------------------------------
  const settlementAddr = await vault.settlement();
  const settlement = new ethers.Contract(settlementAddr, tokenArtifact.abi, provider);
  const settlementDec = Number(await settlement.decimals());
  const cashRaw = await settlement.balanceOf(vaultAddress);

  const basketLength = Number(await vault.basketLength());
  const tokens = {}; // symbol -> {address, decimals, price}
  const holdings = { SETTLEMENT: Number(ethers.formatUnits(cashRaw, settlementDec)) };
  const prices = {};
  const basket = [];
  for (let i = 0; i < basketLength; i++) {
    const addr = await vault.basket(i);
    const token = new ethers.Contract(addr, tokenArtifact.abi, provider);
    const symbol = await token.symbol();
    const dec = Number(await token.decimals());
    const bal = await token.balanceOf(vaultAddress);
    const priceWei = await oracle.getPrice(addr);
    tokens[symbol] = { address: addr, decimals: dec, priceWei };
    holdings[symbol] = Number(ethers.formatUnits(bal, dec));
    prices[symbol] = Number(ethers.formatUnits(priceWei, 18));
    basket.push(symbol);
  }

  const navBefore = Number(ethers.formatUnits(await vault.nav(), 18));
  const plan = planEqualWeight(holdings, prices, basket, {
    cashBufferBps: 1000,
    maxTradeBps: 2500,
    minTradeUsd: 5,
  });

  const reason =
    `cycle: equal-weight rebalance | NAV $${plan.nav} | target $${plan.targetPerToken}/token | ` +
    `${plan.trades.length} trades | prices read live from PriceOracle on Base Sepolia (simulated)`;

  console.log('=== StockMaxx agent — ONCHAIN (Base Sepolia) ===');
  console.log(`vault: ${vaultAddress} | agent: ${signer.address}`);
  console.log(`NAV (live): $${navBefore.toFixed(2)} | holdings: ${JSON.stringify(holdings)}`);
  for (const n of plan.notes) console.log(`  note: ${n}`);

  const record = {
    mode: 'onchain',
    network: 'base-sepolia',
    chainId: 84532,
    vault: vaultAddress,
    at: new Date().toISOString(),
    reason,
    holdings,
    prices,
    plan,
    txs: [],
  };

  if (plan.trades.length === 0 && !process.env.FORCE_CYCLE) {
    console.log('no trades needed — no cycle committed (set FORCE_CYCLE=1 to log a decision anyway)');
    fs.writeFileSync(path.join(DIR, 'last-plan.json'), JSON.stringify(record, null, 2));
    return record;
  }

  // --- Commit the decision on-chain ----------------------------------------
  const decisionTx = await vault.logDecision(reason);
  const decisionReceipt = await decisionTx.wait();
  if (decisionReceipt.status !== 1) throw new Error(`logDecision reverted: ${decisionTx.hash}`);
  const cycleId = Number(await vault.cycleCount());
  record.cycleId = cycleId;
  record.txs.push({ kind: 'logDecision', hash: decisionTx.hash, block: decisionReceipt.blockNumber });
  console.log(`DECISION committed — cycle ${cycleId}, tx ${decisionTx.hash}`);

  // --- Execute the planned trades -------------------------------------------
  // 0.1% safety shave so oracle-side rounding can never push a trade a
  // hair over the vault's per-trade NAV cap.
  for (const trade of plan.trades) {
    const usdWei = ethers.parseUnits(trade.usd.toFixed(2), 18) * 999n / 1000n;
    let tokenIn; let tokenOut; let amountIn;
    if (trade.side === 'BUY') {
      tokenIn = settlementAddr;
      tokenOut = tokens[trade.token].address;
      amountIn = (usdWei * 10n ** BigInt(settlementDec)) / 10n ** 18n;
    } else {
      tokenIn = tokens[trade.token].address;
      tokenOut = settlementAddr;
      amountIn = (usdWei * 10n ** BigInt(tokens[trade.token].decimals)) / tokens[trade.token].priceWei;
    }
    if (amountIn === 0n) {
      console.log(`  ${trade.side} ${trade.token}: skipped (dust after conversion)`);
      continue;
    }
    const tx = await vault.executeTrade(tokenIn, tokenOut, amountIn);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`executeTrade ${trade.side} ${trade.token} reverted: ${tx.hash}`);
    record.txs.push({ kind: 'executeTrade', side: trade.side, token: trade.token, usd: trade.usd, hash: tx.hash, block: receipt.blockNumber });
    console.log(`  ${trade.side} ${trade.token}: $${trade.usd} — tx ${tx.hash}`);
  }

  const navAfter = Number(ethers.formatUnits(await vault.nav(), 18));
  record.navBefore = navBefore;
  record.navAfter = navAfter;
  console.log(`cycle ${cycleId} complete — NAV $${navBefore.toFixed(2)} -> $${navAfter.toFixed(2)}`);

  fs.writeFileSync(path.join(DIR, 'last-plan.json'), JSON.stringify(record, null, 2));
  const cyclesFile = path.join(DIR, '..', 'runtime', 'cycles.json');
  const cycles = fs.existsSync(cyclesFile) ? JSON.parse(fs.readFileSync(cyclesFile, 'utf8')) : [];
  cycles.push(record);
  fs.writeFileSync(cyclesFile, JSON.stringify(cycles, null, 2));
  console.log(`plan written to agent/last-plan.json; cycle appended to runtime/cycles.json`);
  return record;
}

const args = process.argv.slice(2);
if (args.includes('--onchain')) {
  onchain().catch((e) => {
    console.error('ONCHAIN FAILED:', e.message);
    process.exit(1);
  });
} else {
  const pIdx = args.indexOf('--portfolio');
  dryRun(pIdx >= 0 ? args[pIdx + 1] : null);
}
