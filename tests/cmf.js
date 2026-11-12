'use strict';
const assert = require('assert');
const CMF = require('../lib/cmf-engine');

const plan = CMF.buildTradePlan({
  equity: 10000, side: 'buy', entry: 100, stop: 95, target: 110,
  riskPct: 1, leverage: 2, maxMarginPct: 25
});
assert.strictEqual(plan.riskBudget, 100);
assert.strictEqual(plan.notional, 2000);
assert.strictEqual(plan.estimatedMargin, 1000);
assert.strictEqual(plan.rewardRisk, 2);
assert.ok(plan.actualRiskPct <= 1.0001);

const capped = CMF.buildTradePlan({
  equity: 1000, side: 'sell', entry: 100, stop: 110,
  riskPct: 2, leverage: 1, maxMarginPct: 10
});
assert.strictEqual(capped.notional, 100);
assert.strictEqual(capped.cappedBy, 'margin_budget');

assert.throws(() => CMF.buildTradePlan({
  equity: 1000, side: 'buy', entry: 100, stop: 105
}), /Stop must be below entry/);
assert.throws(() => CMF.buildTradePlan({
  equity: 1000, side: 'sell', entry: 100, stop: 95
}), /Stop must be above entry/);

const projection = CMF.projectCompounding({
  startingCapital: 1000, returnsPct: [10, -5, 10], feePct: 0
});
assert.strictEqual(projection.endingCapital, 1149.5);
assert.strictEqual(projection.periods, 3);
assert.ok(projection.maxDrawdownPct > 0);
assert.throws(() => CMF.projectCompounding({
  startingCapital: 1000, returnsPct: [-101]
}), /between -100% and 1000%/);

const candles = [
  { high: 10, low: 8, close: 9 },
  { high: 12, low: 9, close: 11 },
  { high: 11, low: 7, close: 8 },
  { high: 10, low: 6, close: 7 },
  { high: 9, low: 5, close: 8 },
  { high: 11, low: 7, close: 10 },
  { high: 13, low: 8, close: 12 },
  { high: 12, low: 9, close: 11 }
];
const structure = CMF.analyseMarketStructure(candles, 1);
assert.ok(Array.isArray(structure.swings));
assert.ok(Array.isArray(structure.events));
assert.ok(['neutral', 'bullish', 'bearish'].includes(structure.bias));

console.log('[cmf] all CMF engine tests passed');
