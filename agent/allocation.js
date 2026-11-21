'use strict';
/**
 * allocation.js — the StockMaxx agent's decision core (pure functions).
 *
 * Strategy v1: EQUAL WEIGHT. The agent targets the same USD weight in every
 * allowlisted stock token and keeps the remainder in settlement cash. For
 * each token it computes the drift between current and target value and
 * emits concrete trades, mirroring the on-chain guardrails off-chain so a
 * plan never contains a trade the vault would reject:
 *
 *   - a single trade never exceeds `maxTradeBps` of NAV (split if needed —
 *     v1 simply clamps and leaves the rest for the next cycle);
 *   - trades smaller than `minTradeUsd` are skipped (dust filter);
 *   - sells are planned before buys so buys are funded by freed settlement.
 *
 * All values here are plain JS numbers in USD (off-chain planning only).
 * On-chain accounting is integer-exact inside the contracts.
 */

function computeNav(holdings, prices) {
  // holdings: { SETTLEMENT: usdAmount, TOKEN: shares, ... }
  // prices:   { TOKEN: usdPerWholeToken, ... } (SETTLEMENT is always 1)
  let nav = holdings.SETTLEMENT || 0;
  for (const [token, shares] of Object.entries(holdings)) {
    if (token === 'SETTLEMENT') continue;
    const price = prices[token];
    if (price === undefined) throw new Error(`missing price for ${token}`);
    nav += shares * price;
  }
  return nav;
}

function currentValues(holdings, prices) {
  const values = {};
  for (const [token, shares] of Object.entries(holdings)) {
    if (token === 'SETTLEMENT') continue;
    values[token] = shares * prices[token];
  }
  return values;
}

/**
 * Plan an equal-weight rebalance.
 *
 * @param {Object} holdings  shares per token + SETTLEMENT cash in USD
 * @param {Object} prices    USD price per whole token
 * @param {string[]} basket  allowlisted stock token symbols
 * @param {Object} opts      { cashBufferBps, maxTradeBps, minTradeUsd }
 * @returns {{nav:number, targetPerToken:number, trades:Array, notes:string[]}}
 *   trades: [{ token, side: 'BUY'|'SELL', usd }] — SELLs first, then BUYs.
 */
function planEqualWeight(holdings, prices, basket, opts = {}) {
  const cashBufferBps = opts.cashBufferBps ?? 1000; // keep 10% in settlement
  const maxTradeBps = opts.maxTradeBps ?? 2500; // mirror of vault guardrail
  const minTradeUsd = opts.minTradeUsd ?? 5;

  const notes = [];
  const nav = computeNav(holdings, prices);
  if (nav <= 0) return { nav, targetPerToken: 0, trades: [], notes: ['NAV is zero — nothing to do'] };
  if (basket.length === 0) return { nav, targetPerToken: 0, trades: [], notes: ['empty basket'] };

  const investable = nav * (1 - cashBufferBps / 10000);
  const targetPerToken = investable / basket.length;
  const maxTradeUsd = (nav * maxTradeBps) / 10000;
  const values = currentValues(holdings, prices);

  const sells = [];
  const buys = [];
  for (const token of basket) {
    const current = values[token] || 0;
    const drift = targetPerToken - current; // + buy, - sell
    if (Math.abs(drift) < minTradeUsd) {
      notes.push(`${token}: drift $${drift.toFixed(2)} below min trade $${minTradeUsd} — skip`);
      continue;
    }
    let usd = Math.abs(drift);
    if (usd > maxTradeUsd) {
      notes.push(`${token}: trade clamped to per-trade cap $${maxTradeUsd.toFixed(2)} (rest next cycle)`);
      usd = maxTradeUsd;
    }
    const trade = { token, side: drift > 0 ? 'BUY' : 'SELL', usd: round2(usd) };
    (drift > 0 ? buys : sells).push(trade);
  }

  // Buys cannot exceed settlement available after sells land.
  let cash = (holdings.SETTLEMENT || 0) + sells.reduce((s, t) => s + t.usd, 0);
  const fundedBuys = [];
  for (const buy of buys) {
    if (buy.usd <= cash + 1e-9) {
      fundedBuys.push(buy);
      cash -= buy.usd;
    } else if (cash >= minTradeUsd) {
      notes.push(`${buy.token}: buy reduced to available cash $${cash.toFixed(2)}`);
      fundedBuys.push({ ...buy, usd: round2(cash) });
      cash = 0;
    } else {
      notes.push(`${buy.token}: buy skipped — no settlement available`);
    }
  }

  return { nav: round2(nav), targetPerToken: round2(targetPerToken), trades: [...sells, ...fundedBuys], notes };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { computeNav, currentValues, planEqualWeight };
