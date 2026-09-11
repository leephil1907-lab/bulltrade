#!/usr/bin/env python3
"""Currency-symbol fixes: no hardcoded $ anywhere user-visible (display-only conversion).
Account-op inputs stay explicitly USD. Run from repo root. Idempotent per pair."""
import re

def patch(path, pairs, regexes=()):
    t = open(path).read(); n = 0
    for old, new in pairs:
        if old in t: t = t.replace(old, new, 1); n += 1
        elif new not in t: print(f'  MISS {path}: {old[:55]!r}')
    for pat, rep in regexes: t, k = re.subn(pat, rep, t); n += k
    open(path, 'w').write(t); print(f'{path}: {n} edits')

patch('public/index.html', [], [(re.escape('$${BB.fmtPrice('), '${BB.fmtPx(')])
patch('public/markets.html', [], [(re.escape('$${BB.fmtPrice('), '${BB.fmtPx(')])
patch('public/trade.html', [], [(re.escape('$${BB.fmtPrice('), '${BB.fmtPx(')])
patch('public/dashboard.html', [], [(re.escape('$${BB.fmtPrice('), '${BB.fmtPx(')])

patch('public/markets.html', [
  ("$('#psCap').textContent = cap ? '$' + (cap / 1e12).toFixed(2) + 'T' : '—';", "$('#psCap').textContent = cap ? BB.fmtCompact(cap) : '—';"),
  ("${a.marketCap ? '$' + (a.marketCap / 1e9).toFixed(2) + 'B' : a.volume24h ? '$' + (a.volume24h / 1e6).toFixed(1) + 'M vol' : '—'}", "${a.marketCap ? BB.fmtCompact(a.marketCap) : a.volume24h ? BB.fmtCompact(a.volume24h) + ' vol' : '—'}"),
  ("${a.marketCap ? '$' + (a.marketCap / 1e9).toFixed(2) + 'B' : '—'}", "${a.marketCap ? BB.fmtCompact(a.marketCap) : '—'}"),
  ("${a.volume24h ? '$' + (a.volume24h / 1e6).toFixed(1) + 'M' : '—'}", "${a.volume24h ? BB.fmtCompact(a.volume24h) : '—'}"),
])
patch('public/index.html', [("${a.marketCap ? '$' + (a.marketCap / 1e9).toFixed(1) + 'B' : '—'}", "${a.marketCap ? BB.fmtCompact(a.marketCap) : '—'}")])
patch('public/dashboard.html', [
  ("ctx.fillText('$' + Math.round(v), w - padR + 6, y + 3);", "ctx.fillText(BB.sym() + Math.round(BB.conv(v)).toLocaleString('en-US'), w - padR + 6, y + 3);"),
  ("ctx.fillText('$' + Math.round(total).toLocaleString(), 90, 88);", "ctx.fillText(BB.fmtUSD(total, 0), 90, 88);"),
  ("'⚡ Triggered ' + BB.timeAgo(a.triggeredAt) + ' @ $' + BB.fmtPrice(a.triggeredPrice)", "'⚡ Triggered ' + BB.timeAgo(a.triggeredAt) + ' @ ' + BB.fmtPx(a.triggeredPrice)"),
  ("$('#alPrice').placeholder = 'Now $' + BB.fmtPrice(r3.price);", "$('#alPrice').placeholder = 'Now ' + BB.fmtPx(r3.price);"),
])
patch('public/trade.html', [
  ('<div class="field"><label>Take-profit ($)</label>', '<div class="field"><label data-i18n="trd.tp">Take-profit (USD)</label>'),
  ('<div class="field"><label>Stop-loss ($)</label>', '<div class="field"><label data-i18n="trd.sl">Stop-loss (USD)</label>'),
])

W = lambda n, txt: f'<span data-usd="{n}">{txt}</span>'
patch('public/index.html', [
  ('👉 One-Time: $497', '👉 One-Time: ' + W(497, '$497')),
  ('<div class="pc-price">$497 <small>one-time</small></div>', '<div class="pc-price">' + W(497, '$497') + ' <small>one-time</small></div>'),
  ('<div class="pc-price">$27 <small>only</small></div>', '<div class="pc-price">' + W(27, '$27') + ' <small>only</small></div>'),
  ('<div class="pc-price">$47 <small>combo</small></div>', '<div class="pc-price">' + W(47, '$47') + ' <small>combo</small></div>'),
  ('with live prices and a free $10,000 demo.', 'with live prices and a free ' + W(10000, '$10,000') + ' demo.'),
  ('Start Free — Get $10,000 Demo', 'Start Free — Get ' + W(10000, '$10,000') + ' Demo'),
])
patch('public/contact.html', [
  ('<b class="font-head" style="color:var(--green-bright)">$497</b>', '<b class="font-head" style="color:var(--green-bright)">' + W(497, '$497') + '</b>'),
  ('<b class="font-head" style="color:var(--green-bright)">$27</b>', '<b class="font-head" style="color:var(--green-bright)">' + W(27, '$27') + '</b>'),
  ('<b class="font-head" style="color:var(--green-bright)">$47</b>', '<b class="font-head" style="color:var(--green-bright)">' + W(47, '$47') + '</b>'),
])
patch('public/funding.html', [
  ('Minimum <b>$50</b> value.', 'Minimum <b>' + W(50, '$50') + '</b> value.'),
  ('placeholder="Min. $20"', 'placeholder="Min. $20 (USD)" data-i18n-ph="fun.wdPh"'),
  ('<h3>Reset your demo balance to $10,000</h3>', '<h3>Reset your demo balance to ' + W(10000, '$10,000') + '</h3>'),
])
patch('public/login.html', [('— includes $10,000 demo funds.', '— includes ' + W(10000, '$10,000') + ' demo funds.')])
patch('public/mentorship.html', [('<b style="color:var(--gold)">$10,000</b>', '<b style="color:var(--gold)">' + W(10000, '$10,000') + '</b>')])
patch('public/signup.html', [
  ('<span class="eyebrow">Free Account · $10,000 Demo Included</span>', '<span class="eyebrow">Free Account · ' + W(10000, '$10,000') + ' Demo Included</span>'),
  ('<b style="color:var(--green-bright)">$10,000 in demo funds</b>', '<b style="color:var(--green-bright)">' + W(10000, '$10,000') + ' in demo funds</b>'),
])
patch('public/store.html', [
  ('<div class="pc-price">$497 <small>one-time</small></div>', '<div class="pc-price">' + W(497, '$497') + ' <small>one-time</small></div>'),
  ('Buy with Crypto — $497', 'Buy with Crypto — ' + W(497, '$497')),
  ('<div class="pc-price">$27 <small>only</small></div>', '<div class="pc-price">' + W(27, '$27') + ' <small>only</small></div>'),
  ('Buy with Crypto — $27', 'Buy with Crypto — ' + W(27, '$27')),
  ('<div class="pc-price">$47 <small>combo</small></div>', '<div class="pc-price">' + W(47, '$47') + ' <small>combo</small></div>'),
  ('Buy with Crypto — $47', 'Buy with Crypto — ' + W(47, '$47')),
])
patch('public/trade.html', [
  ('practice with $10,000 virtual funds', 'practice with ' + W(10000, '$10,000') + ' virtual funds'),
  ('placeholder="Min. $10"', 'placeholder="Min. $10 (USD)" data-i18n-ph="trd.amtPh"'),
  ('<b id="sumNotional">$0.00</b>', '<b id="sumNotional" data-usd="0">$0.00</b>'),
  ('<b id="sumMargin">$0.00</b>', '<b id="sumMargin" data-usd="0">$0.00</b>'),
  ('<b id="sumFee">$0.00</b>', '<b id="sumFee" data-usd="0">$0.00</b>'),
  ("if (!confirm('Reset your demo account to $10,000 and close all demo positions?')) return;", "if (!confirm('Reset your demo account to ' + BB.fmtUSD(10000) + ' and close all demo positions?')) return;"),
])
patch('public/cmf-engine.html', [('and a $10,000 demo.', 'and a ' + W(10000, '$10,000') + ' demo.')])
patch('public/legal.html', [('The Elite Mentorship investment is $10,000, payable in full', 'The Elite Mentorship investment is ' + W(10000, '$10,000') + ', payable in full')])
patch('public/trading-bots.html', [('Start with Bull Scout at $2,500 and unlock', 'Start with Bull Scout at ' + W(2500, '$2,500') + ' and unlock')])
patch('public/community.html', [
  ('Apply the lessons with $10,000 demo funds and live market prices.', 'Apply the lessons with ' + W(10000, '$10,000') + ' demo funds and live market prices.'),
  ('1 · Create your free account (includes $10,000 demo funds).', '1 · Create your free account (includes ' + W(10000, '$10,000') + ' demo funds).'),
])
print('CURRENCY PATCHES APPLIED')
