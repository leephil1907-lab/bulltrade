#!/usr/bin/env python3
"""Swap JS-rendered UI strings to BB.t() and tag placeholders with data-i18n-ph.
Records every new key's EN text into tools/i18n-js-en.json."""
import json, re

JS = {}  # key -> EN text

def T(key, en):
    JS[key] = en
    return "${BB.t('%s')}" % key

def patch(path, pairs):
    t = open(path).read(); miss = 0
    for old, new in pairs:
        if old in t: t = t.replace(old, new, 1)
        else: print(f'  MISS {path}: {old[:60]!r}'); miss += 1
    open(path, 'w').write(t)
    print(f'{path}: {len(pairs) - miss}/{len(pairs)}')

# ---------------- placeholders (data-i18n-ph) ----------------
def ph(path, pairs):
    patch(path, [(f'placeholder="{p}"', f'placeholder="{p}" data-i18n-ph="{k}"') for k, p in pairs])
    for k, p in pairs: JS[k] = p

ph('public/community.html', [('com.goalsPh', 'e.g. Learn to read charts, stop over-leveraging, build a disciplined system…')])
ph('public/dashboard.html', [('dash.tfaPh', '6-digit code')])
ph('public/forgot-password.html', [('fpw.emailPh', 'you@example.com')])
ph('public/funding.html', [('fun.wdAddrPh', 'Paste destination wallet address')])
ph('public/kyc.html', [
    ('kyc.namePh', 'Full legal name'), ('kyc.idPh', 'Document / ID number'),
    ('kyc.addrPh', 'Residential address (street & number)'), ('kyc.cityPh', 'City / State'),
    ('kyc.countryPh', 'Country')])
ph('public/login.html', [('log.emailPh', 'you@example.com'), ('log.pwPh', 'Your password')])
ph('public/markets.html', [('mkt.searchPh', 'Search assets… (e.g. BTC, Apple, gold)')])
ph('public/reset-password.html', [('rpw.pwPh', 'Min. 8 characters'), ('rpw.pw2Ph', 'Repeat password')])
ph('public/signup.html', [
    ('sig.pwPh', 'Min. 8 characters'), ('sig.pw2Ph', 'Repeat password'),
    ('sig.kycNamePh', 'Full legal name'), ('sig.kycIdPh', 'Document / ID number'),
    ('sig.kycAddrPh', 'Residential address (street &amp; number)'), ('sig.kycCityPh', 'City / State')])
ph('public/trade.html', [
    ('trd.searchPh', 'Search asset…'), ('trd.tpPh', 'TP price'), ('trd.slPh', 'SL price'),
    ('trd.optionalPh', 'optional')])

# ---------------- markets.html: coin view + vol ----------------
patch('public/markets.html', [
    ('<small>Prev close</small>', '<small>' + T('mkt.prevClose', 'Prev close') + '</small>'),
    ('<small>Market cap</small>', '<small>' + T('mkt.mcap', 'Market cap') + '</small>'),
    ('<small>Volume 24h</small>', '<small>' + T('mkt.vol24', 'Volume 24h') + '</small>'),
    ("+ ' vol'", '+' + " " + T('mkt.vol', 'vol')),
])

# ---------------- trade.html: tables, empty states, wallet ----------------
patch('public/trade.html', [
    ("<th>Asset</th><th>Side</th><th>Type</th><th>Limit price</th><th>Amount</th><th>Leverage</th><th>Placed</th><th></th>",
     "<th>" + T('trd.thAsset', 'Asset') + "</th><th>" + T('trd.thSide', 'Side') + "</th><th>" + T('trd.thType', 'Type') + "</th><th>" + T('trd.thLimit', 'Limit price') + "</th><th>" + T('trd.thAmount', 'Amount') + "</th><th>" + T('trd.thLev', 'Leverage') + "</th><th>" + T('trd.thPlaced', 'Placed') + "</th><th></th>"),
    ("<th>Time</th><th>Asset</th><th>Action</th><th>Side</th><th>Price</th><th>Size (USD)</th><th>Fee</th><th>Realized P/L</th>",
     "<th>" + T('trd.thTime', 'Time') + "</th><th>" + T('trd.thAsset', 'Asset') + "</th><th>" + T('trd.thAction', 'Action') + "</th><th>" + T('trd.thSide', 'Side') + "</th><th>" + T('trd.thPrice', 'Price') + "</th><th>" + T('trd.thSizeUsd', 'Size (USD)') + "</th><th>" + T('trd.thFee', 'Fee') + "</th><th>" + T('trd.thPL', 'Realized P/L') + "</th>"),
    ("<i class=\"fas fa-clock\"></i>No open orders.", "<i class=\"fas fa-clock\"></i>" + T('trd.noOrders', 'No open orders.')),
    ("<i class=\"fas fa-clock-rotate-left\"></i>No trades yet.", "<i class=\"fas fa-clock-rotate-left\"></i>" + T('trd.noTrades', 'No trades yet.')),
    ("${BB.fmtUSD(r.equity.free)} free`;", "${BB.fmtUSD(r.equity.free)} " + T('trd.free', 'free') + "`;"),
    ('<i class="fas fa-check"></i> Save Changes</button>', '<i class="fas fa-check"></i> ' + T('trd.saveChanges', 'Save Changes') + '</button>'),
])

# ---------------- dashboard.html: cards, tables, alerts, contest ----------------
patch('public/dashboard.html', [
    ("{ label: 'Live Equity', icon: 'fa-bolt',", "{ label: BB.t('dash.liveEq'), icon: 'fa-bolt',"),
    ("{ label: 'Demo Equity', icon: 'fa-flask',", "{ label: BB.t('dash.demoEq'), icon: 'fa-flask',"),
    ("{ label: 'Account Adjustment', icon: 'fa-sliders',", "{ label: BB.t('dash.adj'), icon: 'fa-sliders',"),
    ("<th>Holding</th><th class=\"num\">Qty</th><th class=\"num\">Price</th><th class=\"num\">Value</th><th class=\"num\" style=\"min-width:90px\">Share</th>",
     "<th>" + T('dash.thHolding', 'Holding') + "</th><th class=\"num\">" + T('dash.thQty', 'Qty') + "</th><th class=\"num\">" + T('dash.thPrice', 'Price') + "</th><th class=\"num\">" + T('dash.thValue', 'Value') + "</th><th class=\"num\" style=\"min-width:90px\">" + T('dash.thShare', 'Share') + "</th>"),
    ("<th>Asset</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Liq. price</th><th>Margin</th><th>P/L</th><th></th>",
     "<th>" + T('dash.thAsset', 'Asset') + "</th><th>" + T('dash.thSide', 'Side') + "</th><th>" + T('dash.thSize', 'Size') + "</th><th>" + T('dash.thEntry', 'Entry') + "</th><th>" + T('dash.thMark', 'Mark') + "</th><th>" + T('dash.thLiq', 'Liq. price') + "</th><th>" + T('dash.thMargin', 'Margin') + "</th><th>P/L</th><th></th>"),
    ("<th>Time</th><th>Asset</th><th>Action</th><th>Side</th><th>Price</th><th>Size</th><th>Fee</th><th>Realized P/L</th>",
     "<th>" + T('dash.thTime', 'Time') + "</th><th>" + T('dash.thAsset', 'Asset') + "</th><th>" + T('dash.thAction', 'Action') + "</th><th>" + T('dash.thSide', 'Side') + "</th><th>" + T('dash.thPrice', 'Price') + "</th><th>" + T('dash.thSize', 'Size') + "</th><th>" + T('dash.thFee', 'Fee') + "</th><th>" + T('dash.thPL', 'Realized P/L') + "</th>"),
    ("<i class=\"fas fa-clock-rotate-left\"></i>No trades yet in this mode.", "<i class=\"fas fa-clock-rotate-left\"></i>" + T('dash.noTrades', 'No trades yet in this mode.')),
    ("<i class=\"fas fa-bell\"></i>No alerts yet — get notified when price hits your level.", "<i class=\"fas fa-bell\"></i>" + T('dash.noAlerts', 'No alerts yet — get notified when price hits your level.')),
    ("? '⚡ Triggered ' + BB.timeAgo(a.triggeredAt)", "? BB.t('dash.triggered') + ' ' + BB.timeAgo(a.triggeredAt)"),
    (": 'Waiting · set ' + BB.timeAgo(a.createdAt)", ": BB.t('dash.waiting') + ' ' + BB.timeAgo(a.createdAt)"),
    ("<span class=\"muted small\">Total portfolio value (${pfMode.toUpperCase()})", "<span class=\"muted small\">${BB.t('dash.totalPf')} (${pfMode.toUpperCase()})"),
    ("Cash <b>${BB.fmtUSD(eq.free)}</b> · Coins <b>${BB.fmtUSD(eq.spot || 0)}</b> · Positions <b>${BB.fmtUSD(eq.marginUsed + eq.unrealized)}</b> · Bots <b>${BB.fmtUSD(eq.inCopy || 0)}</b>",
     "${BB.t('dash.cash')} <b>${BB.fmtUSD(eq.free)}</b> · ${BB.t('dash.coins')} <b>${BB.fmtUSD(eq.spot || 0)}</b> · ${BB.t('dash.positions')} <b>${BB.fmtUSD(eq.marginUsed + eq.unrealized)}</b> · ${BB.t('dash.bots')} <b>${BB.fmtUSD(eq.inCopy || 0)}</b>"),
    ("<i class=\"fas fa-trophy\"></i>No qualifying traders yet this week — be the first!", "<i class=\"fas fa-trophy\"></i>" + T('dash.noContest', 'No qualifying traders yet this week — be the first!')),
    ("'Contest currently paused'", "BB.t('dash.contestPaused')"),
])

JS.update({
    'dash.liveEq': 'Live Equity', 'dash.demoEq': 'Demo Equity', 'dash.adj': 'Account Adjustment',
    'dash.totalPf': 'Total portfolio value', 'dash.cash': 'Cash', 'dash.coins': 'Coins',
    'dash.positions': 'Positions', 'dash.bots': 'Bots', 'dash.triggered': '⚡ Triggered',
    'dash.waiting': 'Waiting · set', 'dash.contestPaused': 'Contest currently paused',
})

json.dump(JS, open('tools/i18n-js-en.json', 'w'), ensure_ascii=False, indent=1)
print('js keys:', len(JS))
