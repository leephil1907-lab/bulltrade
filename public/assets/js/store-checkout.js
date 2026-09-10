/* ============================================================
   Blockchain Bullhorn — shared product crypto-checkout
   Used by /store and the homepage product cards.
   Requires: common.js (BB), qrcode.js loaded first.
   Payment is received in USDT (ERC-20) only, to the dedicated
   product wallet configured in Admin → Settings.
   ============================================================ */
'use strict';

    const PRODUCTS = {
      ssc:   { name: 'Super Simple Crypto (Trading) System', price: 497 },
      cheat: { name: 'The Crypto Cheat Guide (Solo) 2026',   price: 27  },
      combo: { name: 'Crypto Cheat Guide — COMBO PACK',      price: 47  }
    };
    const COIN_META = {
      USDT: { img: 'tether.png',       net: 'TRC-20 (Tron)' },
      'USDT-ERC20': { img: 'tether.png', net: 'ERC-20 (Ethereum)' },
      BTC:  { img: 'bitcoin.png',      net: 'Bitcoin network' },
      ETH:  { img: 'ethereum.png',     net: 'ERC-20 (Ethereum)' },
      SOL:  { img: 'solana.png',       net: 'Solana network' },
      BNB:  { img: 'binancecoin.png',  net: 'BEP-20 (BNB Smart Chain)' },
      XRP:  { img: 'ripple.png',       net: 'XRP Ledger' },
      LTC:  { img: 'litecoin.png',     net: 'Litecoin network' },
      DOGE: { img: 'dogecoin.png',     net: 'Dogecoin network' },
      TRX:  { img: 'tron.png',         net: 'Tron network' },
      ZEC:  { img: 'zcash.png',        net: 'Zcash network' }
    };
    let addresses = null, purchases = [];

    function drawQR(box, text) {
      try {
        const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
        const n = qr.getModuleCount(), cell = 4, quiet = 2, size = (n + quiet * 2) * cell;
        const cv = document.createElement('canvas');
        cv.width = cv.height = size; cv.style.width = '148px'; cv.style.height = '148px';
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#24130a';
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
        box.innerHTML = ''; box.appendChild(cv);
      } catch (e) { box.innerHTML = '<span class="muted small">QR unavailable</span>'; }
    }

    function refreshBadges() {
      ['ssc', 'cheat', 'combo'].forEach(id => {
        const el = $('#own-' + id), btn = $(`.btn-buy[data-buy="${id}"]`);
        if (!el) return;
        const p = purchases.find(x => x.productId === id && (x.status === 'pending' || x.status === 'completed'));
        if (p && p.status === 'completed') {
          el.innerHTML = '<span class="own-pill owned"><i class="fas fa-circle-check"></i> Purchased — unlocked on your account</span>';
          if (btn) { btn.disabled = true; btn.style.opacity = .5; btn.innerHTML = '<i class="fas fa-circle-check"></i> Owned'; }
        } else if (p) {
          el.innerHTML = '<span class="own-pill pending"><i class="fas fa-hourglass-half"></i> Payment verification in progress…</span>';
          if (btn) { btn.disabled = true; btn.style.opacity = .5; btn.innerHTML = '<i class="fas fa-hourglass-half"></i> Verifying payment…'; }
        }
      });
    }

    async function openCheckout(productId) {
      if (!BB.user) { BB.toast('Create a free account first — it takes 30 seconds.', 'error'); setTimeout(() => location.href = '/login?next=/store', 900); return; }
      const prod = PRODUCTS[productId]; if (!prod) return;
      if (purchases.some(p => p.productId === productId && p.status === 'pending')) return BB.toast('Your payment for this product is already being verified.');
      if (purchases.some(p => p.productId === productId && p.status === 'completed')) return BB.toast('You already own this product.');
      if (!addresses) {
        const r = await BB.api('/api/store/payment-wallets');
        if (!r.ok) return BB.toast('Could not load payment wallets — please try again.', 'error');
        addresses = r.wallets;
        if (!addresses || !Object.keys(addresses).length) return BB.toast('Crypto payments are being configured — please enquire on live chat.', 'error');
      }
      const coins = Object.keys(addresses).filter(k => String(addresses[k] || '').trim());
      const bd = BB.modal(`Checkout — ${prod.name}`, `
        <div class="flex-between mb-1"><b style="font-family:var(--font-head)">Amount due: $${prod.price}</b><span class="muted small">one-time payment</span></div>
        <p class="muted small" style="margin:0 0 4px"><i class="fas fa-coins"></i> Payment is received in <b>USDT (ERC-20)</b>:</p>
        <div class="coin-grid" id="coinGrid">
          ${coins.map(k => `<button class="coin-pick" data-coin="${k}">
            <img src="/assets/img/coins/${COIN_META[k] ? COIN_META[k].img : 'tether.png'}" alt="${k}">
            <div><b>${k}</b><small>${COIN_META[k] ? COIN_META[k].net : ''}</small></div></button>`).join('')}
        </div>
        <div id="paySteps"></div>`);
      $$('.coin-pick', bd).forEach(b => b.addEventListener('click', () => renderPayStep(bd, productId, b.dataset.coin)));
    }

    function renderPayStep(bd, productId, coin) {
      const prod = PRODUCTS[productId], addr = addresses[coin];
      const meta = COIN_META[coin] || { net: coin };
      $('#paySteps', bd).innerHTML = `
        <div class="card" style="box-shadow:none;background:#faf8f4;margin-top:6px">
          <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
            <div id="buyQr" style="background:#fff;padding:8px;border-radius:10px;border:1px solid var(--line-soft)"></div>
            <div style="flex:1;min-width:220px">
              <div class="muted small">Send <b style="color:var(--ink)">$${prod.price}</b> worth of <b>${coin}</b> (${meta.net}) to:</div>
              <div class="mt-1" style="display:flex;gap:8px;align-items:center">
                <code id="buyAddr" style="flex:1;font-size:12px;word-break:break-all;background:#fff;padding:9px 11px;border:1px solid var(--line-soft);border-radius:8px">${BB.esc(addr)}</code>
                <button class="btn btn-outline btn-sm" id="copyAddr"><i class="fas fa-copy"></i></button>
              </div>
              <div class="muted small mt-1"><i class="fas fa-triangle-exclamation" style="color:var(--gold-deep)"></i> Send ${coin} on <b>${meta.net}</b> only — other networks cannot be recovered.</div>
            </div>
          </div>
          <div class="mt-2">
            <label class="small" style="font-weight:700;font-family:var(--font-head)">Transaction hash (TXID)</label>
            <input class="input" id="buyTxid" placeholder="Paste your TXID after sending the payment" style="width:100%">
          </div>
          <div class="mt-1">
            <label class="small" style="font-weight:700;font-family:var(--font-head)">Payment screenshot / receipt <span style="color:var(--red)">*</span></label>
            <input type="file" id="buyProof" accept=".jpg,.jpeg,.png,.webp,.pdf" style="width:100%;font-size:13px">
          </div>
          <button class="btn btn-primary mt-2" id="buySubmit" style="width:100%"><i class="fas fa-paper-plane"></i> Submit payment for verification</button>
          <p class="muted small mt-1" style="margin-bottom:0"><i class="fas fa-shield-halved"></i> Our team verifies every payment manually. Your product unlocks on your account once approved.</p>
        </div>`;
      drawQR($('#buyQr', bd), addr);
      $('#copyAddr', bd).addEventListener('click', () => {
        navigator.clipboard.writeText(addr).then(() => BB.toast('Wallet address copied'));
      });
      $('#buySubmit', bd).addEventListener('click', async () => {
        const txid = $('#buyTxid', bd).value.trim();
        if (txid.length < 10) return BB.toast('Paste the transaction hash (TXID) of your payment.', 'error');
        const f = $('#buyProof', bd).files[0];
        if (!f) return BB.toast('Upload a screenshot or receipt of your payment.', 'error');
        if (f.size > 5 * 1024 * 1024) return BB.toast('Proof file must be under 5MB.', 'error');
        const data = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(f); });
        const btn = $('#buySubmit', bd); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…';
        const r = await BB.api('/api/store/purchase', { method: 'POST', body: { productId, asset: coin, txid, proof: { mime: f.type, name: f.name, data } } });
        if (r.ok) {
          bd.remove();
          purchases.push({ productId, status: 'pending' });
          refreshBadges();
          BB.modal('Payment submitted 🐂', `<div class="text-center" style="padding:12px 6px">
            <i class="fas fa-circle-check" style="font-size:46px;color:var(--green)"></i>
            <h3 style="margin:14px 0 8px">Thank you!</h3>
            <p class="muted">Your payment for <b>${prod.name}</b> has been submitted for verification. Our team will confirm it shortly — you'll be notified and the product will unlock on your account.</p></div>`);
        } else {
          btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit payment for verification';
          BB.toast(r.error || 'Submission failed — please try again.', 'error');
        }
      });
    }
