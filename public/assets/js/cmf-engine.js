'use strict';
/* CMF workbench controller. Uses the existing page classes and same-origin API. */
(function () {
  const $ = id => document.getElementById(id);
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value || 0));
  const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 });
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const show = (id, html) => { const node = $(id); if (node) node.innerHTML = html; };
  const setBusy = (id, busy, label) => {
    const node = $(id);
    if (!node) return;
    if (busy) { node.dataset.originalLabel = node.textContent; node.disabled = true; node.textContent = label || 'Working…'; }
    else { node.disabled = false; if (node.dataset.originalLabel) node.textContent = node.dataset.originalLabel; }
  };
  async function request(path, options) {
    const response = await fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options || {}));
    let payload;
    try { payload = await response.json(); } catch (_) { payload = {}; }
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error || (response.status === 401 || response.status === 403 ? 'Please sign in to use the CMF workbench.' : 'The request could not be completed.'));
      error.status = response.status;
      throw error;
    }
    return payload;
  }
  function renderError(id, error) {
    const auth = error.status === 401 || error.status === 403;
    show(id, '<div class="card" style="padding:14px;border-color:var(--red)"><p style="color:var(--red)">' + escapeHtml(error.message) + '</p>' +
      (auth ? '<a class="btn btn-gold mt-1" href="/login">Sign in</a>' : '') + '</div>');
  }
  function renderPlan(result) {
    const p = result.plan;
    show('cmfPlanResult',
      '<div class="card mt-2" style="padding:16px;background:var(--bg-soft)">' +
      '<b>Saved trade plan</b><div class="grid grid-2 mt-1" style="gap:10px">' +
      '<p class="small">Position size<br><strong>' + number(p.quantity) + '</strong></p>' +
      '<p class="small">Notional value<br><strong>' + money(p.notional) + '</strong></p>' +
      '<p class="small">Estimated margin<br><strong>' + money(p.estimatedMargin) + '</strong></p>' +
      '<p class="small">Loss at stop<br><strong>' + money(p.estimatedLossAtStop) + '</strong></p>' +
      '<p class="small">Actual equity risk<br><strong>' + number(p.actualRiskPct) + '%</strong></p>' +
      '<p class="small">Reward / risk<br><strong>' + (p.rewardRisk == null ? 'Not set' : number(p.rewardRisk) + 'R') + '</strong></p>' +
      '</div><p class="small muted mt-1">Plan ID: ' + escapeHtml(result.run.id) + ' · Not executed</p>' +
      (p.warnings && p.warnings.length ? '<ul class="small mt-1">' + p.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>' : '') +
      '<form class="cmf-journal-form mt-2" data-run-id="' + escapeHtml(result.run.id) + '">' +
      '<label class="small">Record realised P/L (USD)<input name="pnlUsd" type="number" step="any" required style="display:block;width:100%;margin-top:5px;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);color:var(--ink);font:inherit"></label>' +
      '<label class="small mt-1">Symbol (optional)<input name="symbol" maxlength="24" placeholder="BTCUSD" style="display:block;width:100%;margin-top:5px;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);color:var(--ink);font:inherit"></label>' +
      '<label class="small mt-1">Notes (optional)<textarea name="notes" maxlength="1000" rows="2" style="display:block;width:100%;margin-top:5px;padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--card);color:var(--ink);font:inherit"></textarea></label>' +
      '<button class="btn btn-ghost mt-1" type="submit">Save outcome to journal</button></form></div>');
  }
  function renderProjection(result) {
    const p = result.projection;
    show('cmfProjectionResult',
      '<div class="card mt-2" style="padding:16px;background:var(--bg-soft)"><b>Projection saved</b>' +
      '<div class="grid grid-2 mt-1" style="gap:10px">' +
      '<p class="small">Ending capital<br><strong>' + money(p.endingCapital) + '</strong></p>' +
      '<p class="small">Net profit / loss<br><strong>' + money(p.netProfit) + '</strong></p>' +
      '<p class="small">Total return<br><strong>' + number(p.totalReturnPct) + '%</strong></p>' +
      '<p class="small">Maximum drawdown<br><strong>' + number(p.maxDrawdownPct) + '%</strong></p>' +
      '</div><p class="small muted mt-1">' + p.periods + ' periods · Scenario only, not a forecast.</p></div>');
  }
  function renderStructure(result) {
    const s = result.structure;
    show('cmfStructureResult',
      '<div class="card mt-2" style="padding:14px;background:var(--bg-soft)"><b>Detected bias: ' + escapeHtml(s.bias.toUpperCase()) + '</b>' +
      '<p class="small mt-1">' + escapeHtml(s.note) + '</p>' +
      '<p class="small mt-1">Swing points: ' + s.swings.length + ' · Structure events: ' + s.events.length + '</p>' +
      (s.events.length ? '<ul class="small mt-1">' + s.events.map(e => '<li>' + escapeHtml(e.kind.replace(/_/g, ' ').toUpperCase()) + ' at candle ' + (Number(e.index) + 1) + ' · Level ' + number(e.level) + '</li>').join('') + '</ul>' : '<p class="small muted mt-1">No confirmed break event in the supplied candles.</p>') + '</div>');
  }
  function renderHistory(data) {
    const runs = data.runs || [];
    const journal = data.journal || [];
    if (!runs.length && !journal.length) {
      show('cmfHistory', '<p class="small muted">No saved CMF activity yet. Calculate a plan or projection to get started.</p>');
      return;
    }
    const cards = runs.slice(0, 12).map(run => {
      const date = run.createdAt ? new Date(run.createdAt).toLocaleString() : 'Saved';
      const detail = run.type === 'trade_plan'
        ? escapeHtml((run.plan.side || '').toUpperCase()) + ' · Notional ' + money(run.plan.notional) + ' · Risk ' + number(run.plan.actualRiskPct) + '%'
        : 'Projection · Ending capital ' + money(run.projection && run.projection.endingCapital);
      return '<div class="card mt-1" style="padding:12px"><b class="small">' + escapeHtml(run.type === 'trade_plan' ? 'Trade plan' : 'Compounding projection') + '</b><p class="small">' + detail + '</p><p class="small muted">' + escapeHtml(date) + ' · ' + escapeHtml(run.status || 'saved') + '</p></div>';
    }).join('');
    const journalRows = journal.slice(0, 8).map(entry =>
      '<div class="card mt-1" style="padding:12px"><b class="small">' + escapeHtml(entry.symbol || 'Trade outcome') + '</b><p class="small">' + money(entry.pnlUsd) + ' realised P/L · ' + number(entry.returnPct) + '% of notional</p><p class="small muted">' + escapeHtml(entry.notes || '') + '</p></div>'
    ).join('');
    show('cmfHistory', '<p class="small muted">' + runs.length + ' saved runs · ' + journal.length + ' journal entries</p>' + cards + journalRows);
  }
  async function loadOverview() {
    try { renderHistory(await request('/api/cmf/overview', { method: 'GET', headers: {} })); }
    catch (error) {
      if (error.status === 401 || error.status === 403) show('cmfHistory', '<p class="small muted">Sign in to view your private CMF history.</p><a class="btn btn-gold mt-1" href="/login">Sign in</a>');
      else show('cmfHistory', '<p class="small" style="color:var(--red)">' + escapeHtml(error.message) + '</p>');
    }
  }

  const planForm = $('cmfPlanForm');
  if (planForm) planForm.addEventListener('submit', async event => {
    event.preventDefault(); setBusy('cmfPlanSubmit', true, 'Calculating…');
    try {
      const result = await request('/api/cmf/plan', { method: 'POST', body: JSON.stringify({
        equity: $('cmfEquity').value, side: $('cmfSide').value, entry: $('cmfEntry').value,
        stop: $('cmfStop').value, target: $('cmfTarget').value || null,
        riskPct: $('cmfRisk').value, leverage: $('cmfLeverage').value, maxMarginPct: $('cmfMargin').value
      }) });
      renderPlan(result); loadOverview();
    } catch (error) { renderError('cmfPlanResult', error); }
    finally { setBusy('cmfPlanSubmit', false); }
  });

  const projectionForm = $('cmfProjectionForm');
  if (projectionForm) projectionForm.addEventListener('submit', async event => {
    event.preventDefault(); setBusy('cmfProjectionSubmit', true, 'Projecting…');
    try {
      const returnsPct = $('cmfReturns').value.split(',').map(value => value.trim()).filter(Boolean).map(Number);
      if (!returnsPct.length || returnsPct.some(value => !Number.isFinite(value))) throw new Error('Enter one or more valid percentage returns, separated by commas.');
      const result = await request('/api/cmf/projection', { method: 'POST', body: JSON.stringify({
        startingCapital: $('cmfStartingCapital').value, returnsPct, feePct: $('cmfFee').value
      }) });
      renderProjection(result); loadOverview();
    } catch (error) { renderError('cmfProjectionResult', error); }
    finally { setBusy('cmfProjectionSubmit', false); }
  });

  const structureForm = $('cmfStructureForm');
  if (structureForm) structureForm.addEventListener('submit', async event => {
    event.preventDefault(); setBusy('cmfStructureSubmit', true, 'Analysing…');
    try {
      let candles;
      try { candles = JSON.parse($('cmfCandles').value); }
      catch (_) { throw new Error('Candles must be valid JSON.'); }
      const result = await request('/api/cmf/structure', { method: 'POST', body: JSON.stringify({ candles }) });
      renderStructure(result);
    } catch (error) { renderError('cmfStructureResult', error); }
    finally { setBusy('cmfStructureSubmit', false); }
  });

  document.addEventListener('submit', async event => {
    const form = event.target.closest('.cmf-journal-form');
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    const values = new FormData(form);
    try {
      await request('/api/cmf/journal', { method: 'POST', body: JSON.stringify({
        runId: form.dataset.runId, pnlUsd: values.get('pnlUsd'),
        symbol: values.get('symbol'), notes: values.get('notes')
      }) });
      form.innerHTML = '<p class="small" style="color:var(--green)">Outcome saved to your CMF journal.</p>';
      loadOverview();
    } catch (error) {
      const message = document.createElement('p');
      message.className = 'small mt-1';
      message.style.color = 'var(--red)';
      message.textContent = error.message;
      form.appendChild(message);
      if (button) { button.disabled = false; button.textContent = 'Save outcome to journal'; }
    }
  });

  loadOverview();
})();