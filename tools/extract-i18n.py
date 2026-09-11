#!/usr/bin/env python3
"""Extract translatable strings from all public pages, tag them with data-i18n attrs,
and emit a per-page EN dictionary for translation. Run from repo root."""
import json, re, sys
from bs4 import BeautifulSoup, NavigableString, Tag

PAGES = {
    'index.html': 'idx', 'markets.html': 'mkt', 'trade.html': 'trd', 'dashboard.html': 'dash',
    'funding.html': 'fun', 'store.html': 'str', 'mentorship.html': 'ment', 'cmf-engine.html': 'cmf',
    'community.html': 'com', 'kyc.html': 'kyc', 'faq.html': 'faq', 'contact.html': 'con',
    'avoid-scams.html': 'scam', 'legal.html': 'leg', 'login.html': 'log', 'signup.html': 'sig',
    'forgot-password.html': 'fpw', 'reset-password.html': 'rpw', 'trading-bots.html': 'tbo',
    '404.html': 'e404', 'offline.html': 'off',
}
WHITELIST = {'h1','h2','h3','h4','h5','h6','p','a','button','label','th','td','li','small',
             'strong','b','span','option','div','dt','dd','blockquote','figcaption','summary','legend'}
SKIP_IN = {'script','style','noscript','template','svg','head','code','pre','select'}
# text that carries no translatable words: numbers, symbols, tickers, all-caps codes
SYMBOLIC = re.compile(r'^[\s\d.,%$+×·—–\-:;/()|≥≤≈⚡📈🐂▼▲\u00a0]*$')
ALLCAPS = re.compile(r'^[A-Z0-9][A-Z0-9\/\s\-·:.\u00a0+%]*$')
BRANDS = {'blockchain bullhorn', 'bullhorn', 'cmf engine', 'bull scout', 'golden horn', 'apex bull'}

# seed dedup with existing core keys (same EN text reuses the core key)
core = {'en': json.load(open('i18n-core-en.json'))}
dedup = {}
for k, v in core['en'].items():
    dedup.setdefault(re.sub(r'\s+', ' ', v).strip(), k)

out, report = {}, {}
for fname, prefix in PAGES.items():
    path = 'public/' + fname
    soup = BeautifulSoup(open(path).read(), 'html.parser')
    strings, skipped = {}, []

    def norm(el):
        return re.sub(r'\s+', ' ', el.get_text()).strip()

    def in_skip(el):
        for p in el.parents:
            if isinstance(p, Tag) and (p.name in SKIP_IN or p.get('id') in ('siteHeader', 'siteFooter')):
                return True
        return False

    def iconlike(c):
        return isinstance(c, Tag) and (c.name in ('i', 'svg') or (c.name == 'span' and c.has_attr('data-usd')))

    tagged = []
    counter = [0]
    candidates = soup.find_all(WHITELIST)
    for el in candidates:
        if el in tagged or in_skip(el):
            continue
        if any(p in tagged for p in el.parents):
            continue
        if el.has_attr('data-i18n') or el.has_attr('data-i18n-html'):
            key = el.get('data-i18n') or el.get('data-i18n-html')
            strings[key] = re.sub(r'\s+', ' ', el.decode_contents()).strip()
            continue
        if el.has_attr('data-i18n-ph'):
            strings[el['data-i18n-ph']] = el.get('placeholder', '')
            continue
        txt = norm(el)
        if not txt or SYMBOLIC.match(txt) or ALLCAPS.match(txt) or txt.lower() in BRANDS:
            continue
        kids = [c for c in el.children if not (isinstance(c, NavigableString) and not c.strip())]
        elems = [c for c in kids if isinstance(c, Tag)]
        textnodes = [c for c in kids if isinstance(c, NavigableString) and c.strip()]
        if not elems:                                   # pure text → plain key
            key = dedup.get(txt)
            if not key:
                counter[0] += 1; key = f'{prefix}.s{counter[0]}'; dedup[txt] = key
            el['data-i18n'] = key; strings[key] = txt; tagged.append(el)
        elif all(iconlike(c) for c in elems) and len(textnodes) == 1:
            # icon + one text run (+ data-usd spans): wrap the text in a span IN PLACE
            direct = re.sub(r'\s+', ' ', textnodes[0]).strip()
            key = dedup.get(direct)
            if not key:
                counter[0] += 1; key = f'{prefix}.s{counter[0]}'; dedup[direct] = key
            wrap = soup.new_tag('span'); wrap['data-i18n'] = key
            pos = list(el.contents).index(textnodes[0])
            textnodes[0].extract()
            wrap.append(NavigableString(direct))
            el.insert(pos, wrap)
            strings[key] = direct; tagged.append(el)
        elif all(c.name in (('a','b','strong','em','i','span','small','u','sup','sub','br') if el.name in ('p','li','td','blockquote','dd','dt','figcaption') else ('b','strong','em','i','span','small','u','sup','sub','br')) for c in elems):
            # rich text with inline markup / converted amounts → html key
            # (only when the element itself carries real direct text, so button rows
            #  and stat stacks whose text lives in tagged children stay untouched)
            direct = ''.join(str(c) for c in el.children if isinstance(c, NavigableString)).strip()
            if len(direct) >= 3 and re.search(r'[A-Za-zÀ-ÿ\u0400-\u4fff]', direct):
                counter[0] += 1; key = f'{prefix}.h{counter[0]}'
                html = re.sub(r'\s+', ' ', el.decode_contents()).strip()
                dedup.setdefault(txt, key)
                el['data-i18n-html'] = key; strings[key] = html; tagged.append(el)
            else:
                skipped.append(txt[:70])
        else:
            skipped.append(txt[:70])
    open(path, 'w').write(str(soup))
    out[fname] = strings
    report[fname] = {'tagged': len(strings), 'skipped_complex': len(skipped), 'skipped_sample': skipped[:5]}

json.dump(out, open('i18n-en.json', 'w'), ensure_ascii=False, indent=1)
json.dump(report, open('i18n-report.json', 'w'), ensure_ascii=False, indent=1)
tot = sum(len(v) for v in out.values())
print(f"pages: {len(out)}, strings: {tot}")
for f, r in report.items():
    print(f"  {f}: {r['tagged']} strings, {r['skipped_complex']} complex skipped")
