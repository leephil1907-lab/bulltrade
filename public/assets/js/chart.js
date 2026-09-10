/* ============================================================
   Blockchain Bullhorn — lightweight candlestick chart (canvas)
   Candles + volume + crosshair + tooltip, DPR-aware, zero deps.
   ============================================================ */
'use strict';

class CandleChart {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.candles = [];
    this.cross = null;
    this.indicators = { ema: false, bb: false, rsi: false, macd: false };
    this.opts = Object.assign({ up: '#1ba94b', down: '#e0324b', grid: 'rgba(63,20,12,0.09)', axis: '#97836f', padRight: 66, padBottom: 24 }, opts);
    this.resize();
    this.cv.addEventListener('mousemove', e => {
      const r = this.cv.getBoundingClientRect();
      this.cross = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    this.cv.addEventListener('mouseleave', () => { this.cross = null; this.draw(); });
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(canvas.parentElement || canvas);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.parentElement.clientWidth;
    const h = this.cv.parentElement.clientHeight;
    this.w = w; this.h = h;
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setData(candles) {
    this.candles = candles || [];
    this._ind = CandleChart.computeIndicators(this.candles);
    this.draw();
  }

  setIndicators(obj) {
    Object.assign(this.indicators, obj || {});
    this.draw();
  }

  /** EMA(20), Bollinger(20,2), RSI(14), MACD(12,26,9) over candle closes. */
  static computeIndicators(cs) {
    const closes = cs.map(c => c.c);
    const ema = (period) => {
      const out = []; const k = 2 / (period + 1);
      let prev = null;
      for (let i = 0; i < closes.length; i++) {
        prev = i === 0 ? closes[0] : closes[i] * k + prev * (1 - k);
        out.push(i >= period - 1 ? prev : null);
      }
      return out;
    };
    const ema20 = ema(20), ema12 = ema(12), ema26 = ema(26);
    // Bollinger: SMA20 ± 2σ
    const bbU = [], bbL = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < 19) { bbU.push(null); bbL.push(null); continue; }
      const win = closes.slice(i - 19, i + 1);
      const m = win.reduce((a, b) => a + b, 0) / 20;
      const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) * (b - m), 0) / 20);
      bbU.push(m + 2 * sd); bbL.push(m - 2 * sd);
    }
    // RSI 14 (Wilder)
    const rsi = [];
    let avgG = 0, avgL = 0;
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { rsi.push(null); continue; }
      const ch = closes[i] - closes[i - 1];
      const g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= 14) {
        avgG += g / 14; avgL += l / 14;
        rsi.push(i === 14 ? 100 - 100 / (1 + (avgL === 0 ? 100 : avgG / avgL)) : null);
      } else {
        avgG = (avgG * 13 + g) / 14; avgL = (avgL * 13 + l) / 14;
        rsi.push(100 - 100 / (1 + (avgL === 0 ? 100 : avgG / avgL)));
      }
    }
    // MACD + signal
    const macd = closes.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null));
    const sig = [];
    { const k = 2 / 10; let prev = null;
      for (let i = 0; i < macd.length; i++) {
        if (macd[i] == null) { sig.push(null); continue; }
        prev = prev == null ? macd[i] : macd[i] * k + prev * (1 - k);
        sig.push(prev);
      } }
    const hist = macd.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
    return { ema20, bbU, bbL, rsi, macd, sig, hist, validMacd };
  }

  fmtP(p) {
    if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return p.toFixed(2);
    if (p >= 0.01) return p.toFixed(4);
    return p.toPrecision(4);
  }
  fmtT(t) {
    const d = new Date(t);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  draw() {
    const ctx = this.ctx, { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (!this.candles.length) {
      ctx.fillStyle = this.opts.axis;
      ctx.font = '13px "Quattrocento Sans"';
      ctx.textAlign = 'center';
      ctx.fillText('Loading chart…', w / 2, h / 2);
      return;
    }
    const O = this.opts;
    const padR = O.padRight, padB = O.padBottom, padT = 10, padL = 8;
    const plotW = w - padR - padL;
    const ind = this.indicators, IND = this._ind || {};
    const subPanes = (ind.rsi ? 1 : 0) + (ind.macd ? 1 : 0);
    const subH = subPanes * 62;
    const availH = h - padB - padT - subH;
    const volH = Math.min(70, availH * 0.2);
    const priceH = availH - volH - 8;

    const cs = this.candles;
    let min = Infinity, max = -Infinity, maxV = 0;
    for (const c of cs) { if (c.l < min) min = c.l; if (c.h > max) max = c.h; if (c.v > maxV) maxV = c.v; }
    const span = (max - min) || 1;
    min -= span * 0.05; max += span * 0.05;
    const y = p => padT + priceH - ((p - min) / ((max - min) || 1)) * priceH;
    const cw = plotW / cs.length;
    const x = i => padL + i * cw + cw / 2;

    // grid + price axis
    ctx.strokeStyle = O.grid; ctx.fillStyle = O.axis;
    ctx.font = '10.5px "Quattrocento Sans"'; ctx.textAlign = 'left';
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const p = min + (max - min) * i / steps;
      const yy = y(p);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillText(this.fmtP(p), w - padR + 6, yy + 3.5);
    }
    // time axis
    ctx.textAlign = 'center';
    const tSteps = Math.min(7, cs.length);
    for (let i = 0; i < tSteps; i++) {
      const idx = Math.floor(i * (cs.length - 1) / (tSteps - 1 || 1));
      ctx.fillText(this.fmtT(cs[idx].t), x(idx), h - 7);
    }

    // volume
    if (maxV > 0) {
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        const vh = (c.v / maxV) * volH;
        ctx.fillStyle = c.c >= c.o ? 'rgba(27,169,75,0.22)' : 'rgba(224,50,75,0.2)';
        ctx.fillRect(x(i) - Math.max(1, cw * 0.32), h - padB - vh, Math.max(2, cw * 0.64), vh);
      }
    }

    // candles
    const bodyW = Math.max(1.5, cw * 0.62);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? O.up : O.down;
      ctx.fillStyle = up ? O.up : O.down;
      ctx.lineWidth = 1;
      // wick
      ctx.beginPath();
      ctx.moveTo(x(i), y(c.h));
      ctx.lineTo(x(i), y(c.l));
      ctx.stroke();
      // body
      const yo = y(c.o), yc = y(c.c);
      const top = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
      ctx.globalAlpha = up ? 0.92 : 0.92;
      ctx.fillRect(x(i) - bodyW / 2, top, bodyW, hh);
      ctx.globalAlpha = 1;
    }

    // EMA(20) overlay
    if (ind.ema && IND.ema20) {
      ctx.strokeStyle = '#0047c2'; ctx.lineWidth = 1.6; ctx.beginPath();
      let started = false;
      for (let i = 0; i < cs.length; i++) {
        const v = IND.ema20[i]; if (v == null) continue;
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
      }
      ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = '#0047c2'; ctx.font = 'bold 10px "Quattrocento Sans"'; ctx.textAlign = 'left';
      ctx.fillText('EMA 20', padL + 4, padT + 11);
    }
    // Bollinger Bands overlay
    if (ind.bb && IND.bbU) {
      ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(211,168,119,0.8)'; ctx.lineWidth = 1.2;
      for (const arr of [IND.bbU, IND.bbL]) {
        ctx.beginPath(); let started = false;
        for (let i = 0; i < cs.length; i++) {
          const v = arr[i]; if (v == null) continue;
          if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
        }
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(211,168,119,0.95)'; ctx.font = 'bold 10px "Quattrocento Sans"'; ctx.textAlign = 'left';
      ctx.fillText('BB 20/2', padL + (ind.ema ? 62 : 4), padT + 11);
    }

    // indicator sub-panes (bottom, above time axis)
    let paneTop = h - padB - subH;
    if (subPanes) {
      ctx.strokeStyle = O.grid;
      ctx.beginPath(); ctx.moveTo(padL, paneTop); ctx.lineTo(w - padR, paneTop); ctx.stroke();
    }
    if (ind.rsi && IND.rsi) {
      const top = paneTop; paneTop += 62;
      ctx.fillStyle = O.axis; ctx.font = 'bold 10px "Quattrocento Sans"'; ctx.textAlign = 'left';
      ctx.fillText('RSI 14', padL + 4, top + 12);
      const ry = v => top + 6 + (1 - (v - 0) / 100) * (62 - 14);
      ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(151,131,111,.5)';
      for (const lvl of [30, 70]) { ctx.beginPath(); ctx.moveTo(padL + 46, ry(lvl)); ctx.lineTo(w - padR, ry(lvl)); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(27,169,75,.05)'; ctx.fillRect(padL + 46, ry(70), w - padR - padL - 46, ry(30) - ry(70));
      ctx.strokeStyle = '#9d7bea'; ctx.lineWidth = 1.6; ctx.beginPath(); let st2 = false;
      for (let i = 0; i < cs.length; i++) {
        const v = IND.rsi[i]; if (v == null) continue;
        if (!st2) { ctx.moveTo(x(i), ry(v)); st2 = true; } else ctx.lineTo(x(i), ry(v));
      }
      ctx.stroke(); ctx.lineWidth = 1;
      const lastR = [...IND.rsi].reverse().find(v => v != null);
      if (lastR != null) { ctx.fillStyle = '#9d7bea'; ctx.fillText(lastR.toFixed(1), w - padR + 6, ry(lastR) + 3); }
    }
    if (ind.macd && IND.macd) {
      const top = paneTop;
      ctx.fillStyle = O.axis; ctx.font = 'bold 10px "Quattrocento Sans"'; ctx.textAlign = 'left';
      ctx.fillText('MACD 12/26/9', padL + 4, top + 12);
      const vals = IND.macd.concat(IND.sig).filter(v => v != null);
      const mAbs = Math.max(0.0000001, ...vals.map(v => Math.abs(v)));
      const my = v => top + 31 - (v / mAbs) * 24;
      // histogram
      for (let i = 0; i < cs.length; i++) {
        const v = IND.hist ? IND.hist[i] : null; if (v == null) continue;
        ctx.fillStyle = v >= 0 ? 'rgba(27,169,75,.45)' : 'rgba(224,50,75,.4)';
        const yy = my(v), zero = my(0);
        ctx.fillRect(x(i) - Math.max(1, cw * 0.28), Math.min(yy, zero), Math.max(2, cw * 0.56), Math.max(1, Math.abs(yy - zero)));
      }
      // macd + signal lines
      const drawLine = (arr, color) => {
        ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath(); let st3 = false;
        for (let i = 0; i < cs.length; i++) { const v = arr[i]; if (v == null) continue; if (!st3) { ctx.moveTo(x(i), my(v)); st3 = true; } else ctx.lineTo(x(i), my(v)); }
        ctx.stroke(); ctx.lineWidth = 1;
      };
      drawLine(IND.macd, '#0047c2'); drawLine(IND.sig, '#d3a877');
    }

    // last price line
    const last = cs[cs.length - 1];
    const ly = y(last.c);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = last.c >= last.o ? O.up : O.down;
    ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(w - padR, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = last.c >= last.o ? O.up : O.down;
    const label = this.fmtP(last.c);
    ctx.font = 'bold 10.5px "Quattrocento Sans"';
    const lw = ctx.measureText(label).width + 10;
    ctx.fillRect(w - padR + 2, ly - 9, lw, 18);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(label, w - padR + 7, ly + 3.5);

    // crosshair + tooltip
    if (this.cross && this.cross.x > padL && this.cross.x < w - padR) {
      const idx = Math.max(0, Math.min(cs.length - 1, Math.floor((this.cross.x - padL) / cw)));
      const c = cs[idx];
      ctx.strokeStyle = 'rgba(63,20,12,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x(idx), padT); ctx.lineTo(x(idx), h - padB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, this.cross.y); ctx.lineTo(w - padR, this.cross.y); ctx.stroke();
      ctx.setLineDash([]);
      // tooltip
      const tip = `O ${this.fmtP(c.o)}   H ${this.fmtP(c.h)}\nL ${this.fmtP(c.l)}   C ${this.fmtP(c.c)}\n${this.fmtT(c.t)}`;
      const lines = tip.split('\n');
      ctx.font = '11px "Quattrocento Sans"';
      const tw = Math.max(...lines.map(l => ctx.measureText(l).width)) + 20;
      const th = lines.length * 15 + 12;
      let tx = x(idx) + 12; if (tx + tw > w - padR) tx = x(idx) - tw - 12;
      let ty = Math.max(padT, Math.min(this.cross.y - th / 2, h - padB - th));
      ctx.fillStyle = 'rgba(20,10,6,0.94)';
      ctx.strokeStyle = 'rgba(63,20,12,0.3)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(tx, ty, tw, th, 8); else ctx.rect(tx, ty, tw, th);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f5ede2';
      ctx.textAlign = 'left';
      lines.forEach((l, i) => ctx.fillText(l, tx + 10, ty + 20 + i * 15));
      // price tag at crosshair y
      const cp = min + (1 - (this.cross.y - padT) / priceH) * (max - min);
      if (this.cross.y > padT && this.cross.y < padT + priceH) {
        ctx.fillStyle = '#d3a877';
        ctx.fillRect(w - padR + 2, this.cross.y - 9, ctx.measureText(this.fmtP(cp)).width + 10, 18);
        ctx.fillStyle = '#140a06';
        ctx.fillText(this.fmtP(cp), w - padR + 7, this.cross.y + 3.5);
      }
    }
  }
}
window.CandleChart = CandleChart;
