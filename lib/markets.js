'use strict';
/**
 * Live market data engine for Blockchain Bullhorn.
 * - Crypto  : CoinGecko public API (prices, 24h change, 7d sparkline, market caps, history)
 * - Stocks / Commodities (RWA) / Indices : Yahoo Finance (spark + chart candles)
 * Refreshes every 45s; caches to disk so restarts serve instantly; stale-while-error.
 */
const path = require('path');
const fs = require('fs');
const { fetchJSON, now } = require('./utils');

// ---------------- Asset universe ----------------
const CRYPTO = [
  ['bitcoin', 'BTC', 'Bitcoin'], ['ethereum', 'ETH', 'Ethereum'], ['tether', 'USDT', 'Tether'],
  ['binancecoin', 'BNB', 'BNB'], ['solana', 'SOL', 'Solana'], ['ripple', 'XRP', 'XRP'],
  ['cardano', 'ADA', 'Cardano'], ['dogecoin', 'DOGE', 'Dogecoin'], ['avalanche-2', 'AVAX', 'Avalanche'],
  ['polkadot', 'DOT', 'Polkadot'], ['chainlink', 'LINK', 'Chainlink'], ['litecoin', 'LTC', 'Litecoin'],
  ['tron', 'TRX', 'TRON'], ['polygon-ecosystem-token', 'POL', 'Polygon'],
  ['uniswap', 'UNI', 'Uniswap'], ['shiba-inu', 'SHIB', 'Shiba Inu'], ['bitcoin-cash', 'BCH', 'Bitcoin Cash'],
  ['near', 'NEAR', 'NEAR Protocol'], ['aptos', 'APT', 'Aptos'], ['arbitrum', 'ARB', 'Arbitrum'],
  ['optimism', 'OP', 'Optimism'], ['sui', 'SUI', 'Sui']
];
const RWA_CRYPTO = [
  ['pax-gold', 'PAXG', 'PAX Gold'], ['tether-gold', 'XAUT', 'Tether Gold']
];
const STOCKS = [
  ['AAPL', 'Apple Inc.'], ['MSFT', 'Microsoft Corp.'], ['GOOGL', 'Alphabet Inc.'], ['AMZN', 'Amazon.com Inc.'],
  ['NVDA', 'NVIDIA Corp.'], ['TSLA', 'Tesla Inc.'], ['META', 'Meta Platforms'], ['NFLX', 'Netflix Inc.'],
  ['AMD', 'Advanced Micro Devices'], ['INTC', 'Intel Corp.'], ['ORCL', 'Oracle Corp.'], ['CRM', 'Salesforce Inc.'],
  ['JPM', 'JPMorgan Chase'], ['V', 'Visa Inc.'], ['MA', 'Mastercard Inc.'], ['KO', 'Coca-Cola Co.'],
  ['PEP', 'PepsiCo Inc.'], ['DIS', 'Walt Disney Co.'], ['NKE', 'Nike Inc.'], ['BA', 'Boeing Co.'],
  ['XOM', 'Exxon Mobil'], ['CVX', 'Chevron Corp.'], ['JNJ', 'Johnson & Johnson'], ['PG', 'Procter & Gamble'],
  ['WMT', 'Walmart Inc.'], ['COST', 'Costco Wholesale']
];
const COMMODITIES = [
  ['GC=F', 'Gold', 'XAU'], ['SI=F', 'Silver', 'XAG'], ['PL=F', 'Platinum', 'XPT'],
  ['PA=F', 'Palladium', 'XPD'], ['HG=F', 'Copper', 'HG'], ['CL=F', 'Crude Oil WTI', 'WTI'],
  ['BZ=F', 'Brent Crude', 'BRENT'], ['NG=F', 'Natural Gas', 'NG']
];
const INDICES = [
  ['^GSPC', 'S&P 500', 'SPX'], ['^NDX', 'Nasdaq 100', 'NDX'],
  ['^DJI', 'Dow Jones 30', 'DJI'], ['^RUT', 'Russell 2000', 'RUT']
];

const ASSETS = [];
for (const [id, sym, name] of CRYPTO) ASSETS.push({ id: 'cg-' + id, cgId: id, symbol: sym, name, category: 'crypto', logo: `/assets/img/coins/${id}.png`, tradable: true, maxLeverage: 20 });
for (const [id, sym, name] of RWA_CRYPTO) ASSETS.push({ id: 'cg-' + id, cgId: id, symbol: sym, name, category: 'rwa', logo: `/assets/img/coins/${id}.png`, tradable: true, maxLeverage: 5, tag: 'Tokenized' });
for (const [sym, name] of STOCKS) ASSETS.push({ id: 'yh-' + sym, yhSymbol: sym, symbol: sym, name, category: 'stocks', logo: `/assets/img/stocks/${sym}.png`, tradable: true, maxLeverage: 5 });
for (const [sym, name, code] of COMMODITIES) ASSETS.push({ id: 'yh-' + code, yhSymbol: sym, symbol: code, name, category: 'rwa', logo: null, icon: 'rwa-' + code.toLowerCase(), tradable: true, maxLeverage: 10, tag: 'Real World' });
for (const [sym, name, code] of INDICES) ASSETS.push({ id: 'yh-' + code, yhSymbol: sym, symbol: code, name, category: 'indices', logo: null, icon: 'idx-' + code.toLowerCase(), tradable: true, maxLeverage: 5 });
const byId = {}; ASSETS.forEach(a => byId[a.id] = a);

// ---------------- State ----------------
const quotes = {};   // id -> {price, change24h, changePct, spark:[], marketCap, volume24h, high24h, low24h, prevClose, updated}
let lastRefresh = 0;
let lastError = '';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'market-cache.json');
const candleCache = new Map(); // key -> {data, at}

try {
  const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (c.quotes) Object.assign(quotes, c.quotes);
  if (c.lastRefresh) lastRefresh = c.lastRefresh;
} catch (e) {}

function persist() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ quotes, lastRefresh }));
  } catch (e) {}
}

const REFRESH_MS = 45000;
let refreshing = false;
let started = false;

async function start() {
  if (started) return;
  started = true;
  refresh().catch(() => {});
  setInterval(() => refresh().catch(() => {}), REFRESH_MS);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    // each feed updates quotes independently so one failing doesn't block the other
    const results = await Promise.allSettled([refreshCrypto(), refreshYahoo()]);
    lastRefresh = now();
    const errs = results.filter(r => r.status === 'rejected').map(r => String(r.reason && r.reason.message || r.reason));
    lastError = errs.join('; ');
    if (errs.length) console.error('[markets] partial refresh error:', lastError);
    persist();
    engineTick();
  } catch (e) {
    lastError = e.message;
    console.error('[markets] refresh error:', e.message);
  } finally { refreshing = false; }
}

async function refreshCrypto() {
  const ids = ASSETS.filter(a => a.cgId).map(a => a.cgId).join(',');
  const data = await fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=24h`, { timeout: 15000 });
  for (const c of data) {
    const id = 'cg-' + c.id;
    if (!byId[id]) continue;
    let spark = (c.sparkline_in_7d && c.sparkline_in_7d.price) || [];
    if (spark.length > 42) { // downsample
      const step = Math.floor(spark.length / 42);
      spark = spark.filter((_, i) => i % step === 0);
    }
    quotes[id] = {
      price: c.current_price, change24h: c.price_change_24h,
      changePct: c.price_change_percentage_24h,
      spark, marketCap: c.market_cap, volume24h: c.total_volume,
      high24h: c.high_24h, low24h: c.low_24h, prevClose: c.current_price - (c.price_change_24h || 0),
      updated: now()
    };
  }
}

async function refreshYahoo() {
  const syms = ASSETS.filter(a => a.yhSymbol).map(a => a.yhSymbol);
  const results = [];
  // Yahoo spark caps at 20 symbols per request — batch and merge
  for (let i = 0; i < syms.length; i += 20) {
    const batch = syms.slice(i, i + 20);
    const enc = batch.map(s => encodeURIComponent(s)).join(',');
    try {
      const data = await fetchJSON(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${enc}&range=1d&interval=5m`, { timeout: 15000 });
      results.push(...((data.spark && data.spark.result) || []));
    } catch (e) { /* keep partial results */ }
  }
  for (const r of results) {
    const asset = ASSETS.find(a => a.yhSymbol === r.symbol);
    if (!asset) continue;
    const resp = (r.response && r.response[0]) || {};
    const meta = resp.meta || {};
    const closes = (resp.indicators && resp.indicators.quote && resp.indicators.quote[0] && resp.indicators.quote[0].close) || [];
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.previousClose;
    if (typeof price !== 'number') continue;
    let spark = closes.filter(x => typeof x === 'number');
    if (spark.length > 42) { const step = Math.floor(spark.length / 42); spark = spark.filter((_, i) => i % step === 0); }
    const chg = price - (typeof prev === 'number' ? prev : price);
    quotes[asset.id] = {
      price, change24h: chg, changePct: prev ? (chg / prev) * 100 : 0,
      spark, marketCap: 0, volume24h: 0,
      high24h: meta.regularMarketDayHigh, low24h: meta.regularMarketDayLow, prevClose: prev,
      marketState: meta.marketState || '', updated: now()
    };
  }
}

// ---------------- Public snapshot ----------------
function snapshot() {
  const list = ASSETS.map(a => {
    const q = quotes[a.id] || {};
    return {
      id: a.id, symbol: a.symbol, name: a.name, category: a.category,
      logo: a.logo || null, icon: a.icon || null, tag: a.tag || null,
      tradable: a.tradable, maxLeverage: a.maxLeverage,
      price: q.price != null ? q.price : null,
      changePct: q.changePct != null ? q.changePct : null,
      change24h: q.change24h != null ? q.change24h : null,
      spark: q.spark || [],
      marketCap: q.marketCap || null, volume24h: q.volume24h || null,
      high24h: q.high24h || null, low24h: q.low24h || null,
      marketState: q.marketState || ''
    };
  });
  return { assets: list, updated: lastRefresh, error: lastError, serverTime: now() };
}
function priceOf(id) {
  const q = quotes[id];
  return q ? q.price : null;
}

// ---------------- Candles ----------------
const RANGES = {
  '1D': { cgDays: 1, yh: { interval: '5m', range: '1d' }, bucketMs: 5 * 60 * 1000 },
  '1W': { cgDays: 7, yh: { interval: '30m', range: '5d' }, bucketMs: 60 * 60 * 1000 },
  '1M': { cgDays: 30, yh: { interval: '1h', range: '1mo' }, bucketMs: 4 * 3600 * 1000 },
  '3M': { cgDays: 90, yh: { interval: '1d', range: '3mo' }, bucketMs: 12 * 3600 * 1000 },
  '1Y': { cgDays: 365, yh: { interval: '1d', range: '1y' }, bucketMs: 24 * 3600 * 1000 }
};

async function candles(assetId, range) {
  const asset = byId[assetId];
  if (!asset) throw Object.assign(new Error('Unknown asset'), { status: 404 });
  const R = RANGES[range] || RANGES['1D'];
  const key = assetId + ':' + range;
  const hit = candleCache.get(key);
  if (hit && now() - hit.at < (range === '1D' ? 30000 : 5 * 60000)) return hit.data;
  let data;
  if (asset.cgId) data = await cgCandles(asset.cgId, R);
  else data = await yhCandles(asset.yhSymbol, R, range);
  candleCache.set(key, { data, at: now() });
  return data;
}

async function cgCandles(cgId, R) {
  const j = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${cgId}/market_chart?vs_currency=usd&days=${R.cgDays}`, { timeout: 15000 });
  const prices = j.prices || [];
  return bucketPrices(prices, R.bucketMs);
}
async function yhCandles(sym, R, range) {
  const y = R.yh;
  const enc = encodeURIComponent(sym);
  const j = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=${y.interval}&range=${y.range}&includePrePost=false`, { timeout: 15000 });
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('No chart data');
  const ts = (res.timestamp || []);
  const q = res.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if ([o, h, l, c].some(x => x == null)) continue;
    out.push({ t: ts[i] * 1000, o, h, l, c, v: v || 0 });
  }
  return out;
}
function bucketPrices(prices, bucketMs) {
  const map = new Map();
  for (const [t, p] of prices) {
    const b = Math.floor(t / bucketMs) * bucketMs;
    if (!map.has(b)) map.set(b, { t: b, o: p, h: p, l: p, c: p, v: 0 });
    const k = map.get(b);
    k.h = Math.max(k.h, p); k.l = Math.min(k.l, p); k.c = p;
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

// ---------------- Trading engine tick (limit orders / TP / SL / liquidation) ----------------
let engineTick = () => {};
function onTick(fn) { engineTick = fn; }

module.exports = { start, refresh, snapshot, priceOf, candles, byId, ASSETS, onTick, get lastRefresh() { return lastRefresh; } };
