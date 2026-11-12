'use strict';

/**
 * Bulltrade CMF Engine — deterministic risk, compounding and market-structure
 * calculations. This module is deliberately UI-agnostic: it does not alter
 * pages, styles, routes, or execute orders.
 */

function finitePositive(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(label + ' must be a positive number');
  return n;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function bounded(value, fallback, min, max, label) {
  const n = Number(value == null ? fallback : value);
  if (!Number.isFinite(n)) throw new Error(label + ' must be a finite number');
  return clamp(n, min, max);
}

/**
 * Build a risk-first trade plan.
 * riskPct is the maximum equity fraction to lose if the stop is filled.
 * The notional is capped by leverage and the configured margin allocation.
 */
function buildTradePlan(input) {
  const equity = finitePositive(input.equity, 'Equity');
  const entry = finitePositive(input.entry, 'Entry');
  const stop = finitePositive(input.stop, 'Stop');
  const side = input.side === 'sell' ? 'sell' : input.side === 'buy' ? 'buy' : '';
  if (!side) throw new Error('Side must be buy or sell');
  if (side === 'buy' && stop >= entry) throw new Error('Stop must be below entry for buys');
  if (side === 'sell' && stop <= entry) throw new Error('Stop must be above entry for sells');

  const riskPct = bounded(input.riskPct, 1, 0.1, 5, 'Risk percentage');
  const leverage = bounded(input.leverage, 1, 1, 10, 'Leverage');
  const maxMarginPct = bounded(input.maxMarginPct, 25, 1, 100, 'Maximum margin percentage');
  const feeRate = bounded(input.feeRate, 0.001, 0, 0.05, 'Fee rate');
  const riskBudget = equity * riskPct / 100;
  const stopDistance = Math.abs(entry - stop);
  const stopDistancePct = stopDistance / entry;
  const riskSizedNotional = riskBudget / stopDistancePct;
  const marginCapNotional = equity * maxMarginPct / 100 * leverage;
  const leverageCapNotional = equity * leverage;
  const notional = Math.min(riskSizedNotional, marginCapNotional, leverageCapNotional);
  const quantity = notional / entry;
  const estimatedLossAtStop = quantity * stopDistance;
  const estimatedEntryFee = notional * feeRate;
  const estimatedExitFee = (input.includeExitFee === false ? 0 : notional * feeRate);
  const rewardTarget = input.target == null || input.target === '' ? null : finitePositive(input.target, 'Target');

  if (rewardTarget != null) {
    if ((side === 'buy' && rewardTarget <= entry) || (side === 'sell' && rewardTarget >= entry)) {
      throw new Error('Target must be above entry for buys and below entry for sells');
    }
  }

  const rewardDistance = rewardTarget == null ? null : Math.abs(rewardTarget - entry);
  const rewardRisk = rewardDistance == null ? null : rewardDistance / stopDistance;
  const cappedBy = notional < riskSizedNotional
    ? (marginCapNotional <= leverageCapNotional ? 'margin_budget' : 'leverage')
    : 'risk_budget';

  return {
    side, equity, entry, stop, target: rewardTarget,
    riskPct, riskBudget: round(riskBudget, 2),
    leverage: round(leverage, 4),
    notional: round(notional, 2),
    quantity: round(quantity, 10),
    estimatedMargin: round(notional / leverage, 2),
    estimatedEntryFee: round(estimatedEntryFee, 2),
    estimatedExitFee: round(estimatedExitFee, 2),
    estimatedLossAtStop: round(estimatedLossAtStop, 2),
    actualRiskPct: round(estimatedLossAtStop / equity * 100, 4),
    rewardRisk: rewardRisk == null ? null : round(rewardRisk, 4),
    cappedBy,
    warnings: [
      ...(notional + estimatedEntryFee > equity ? ['Required margin and entry fee exceed available equity'] : []),
      ...(estimatedLossAtStop > riskBudget + 0.01 ? ['Position size was capped; calculated risk is above the requested budget'] : []),
      ...(rewardRisk != null && rewardRisk < 1 ? ['Target reward is smaller than the stop risk'] : [])
    ]
  };
}

/** Apply a sequence of percentage returns to capital, with optional per-side fee. */
function projectCompounding(input) {
  const startingCapital = finitePositive(input.startingCapital, 'Starting capital');
  const returns = Array.isArray(input.returnsPct) ? input.returnsPct : [];
  if (returns.length > 1000) throw new Error('A projection may contain at most 1000 periods');
  const feePct = bounded(input.feePct, 0, 0, 10, 'Fee percentage');
  let capital = startingCapital;
  let peak = capital;
  let maxDrawdownPct = 0;
  const curve = [{ period: 0, capital: round(capital, 2), returnPct: 0 }];
  returns.forEach((raw, index) => {
    const r = Number(raw);
    if (!Number.isFinite(r) || r < -100 || r > 1000) throw new Error('Each period return must be between -100% and 1000%');
    const netPct = r - feePct;
    capital = Math.max(0, capital * (1 + netPct / 100));
    peak = Math.max(peak, capital);
    const drawdown = peak > 0 ? (peak - capital) / peak * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdown);
    curve.push({ period: index + 1, capital: round(capital, 2), returnPct: round(netPct, 4) });
  });
  return {
    startingCapital: round(startingCapital, 2),
    endingCapital: round(capital, 2),
    netProfit: round(capital - startingCapital, 2),
    totalReturnPct: round((capital / startingCapital - 1) * 100, 4),
    maxDrawdownPct: round(maxDrawdownPct, 4),
    periods: returns.length,
    curve
  };
}

/**
 * Detect simple swing-based market structure from OHLC candles.
 * This is a transparent pivot/BOS/CHoCH heuristic, not order-flow data.
 */
function analyseMarketStructure(candles, pivotWindow = 2) {
  if (!Array.isArray(candles) || candles.length < pivotWindow * 2 + 3) {
    return { bias: 'neutral', swings: [], events: [], note: 'Not enough candles to identify reliable swing structure.' };
  }
  const w = Math.floor(clamp(Number(pivotWindow) || 2, 1, 10));
  const swings = [];
  for (let i = w; i < candles.length - w; i++) {
    const c = candles[i];
    const high = Number(c.high), low = Number(c.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    let isHigh = true, isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (Number(candles[j].high) >= high) isHigh = false;
      if (Number(candles[j].low) <= low) isLow = false;
    }
    if (isHigh) swings.push({ type: 'high', index: i, price: high });
    if (isLow) swings.push({ type: 'low', index: i, price: low });
  }

  let bias = 'neutral';
  let lastHigh = null, lastLow = null;
  const events = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const close = Number(c.close);
    if (!Number.isFinite(close)) continue;
    const priorHigh = swings.filter(s => s.type === 'high' && s.index < i).slice(-1)[0];
    const priorLow = swings.filter(s => s.type === 'low' && s.index < i).slice(-1)[0];
    if (priorHigh && close > priorHigh.price && (!lastHigh || lastHigh.index !== priorHigh.index)) {
      const kind = bias === 'bearish' ? 'choch_bullish' : 'bos_bullish';
      events.push({ kind, index: i, level: priorHigh.price });
      bias = 'bullish'; lastHigh = priorHigh;
    }
    if (priorLow && close < priorLow.price && (!lastLow || lastLow.index !== priorLow.index)) {
      const kind = bias === 'bullish' ? 'choch_bearish' : 'bos_bearish';
      events.push({ kind, index: i, level: priorLow.price });
      bias = 'bearish'; lastLow = priorLow;
    }
  }
  return { bias, swings, events, note: 'Swing-pivot heuristic; confirm with volume, liquidity and higher-timeframe context.' };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

module.exports = { buildTradePlan, projectCompounding, analyseMarketStructure };
