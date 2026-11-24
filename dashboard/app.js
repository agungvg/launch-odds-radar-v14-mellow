/* Launch Odds Radar v14 — dashboard. Reads window.RADAR (data.js) and
   renders everything from it; every figure is recomputed here. */
const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const fmt$ = (n) => {
  if (n == null || !isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
};
const fmtInt = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtPct = (n, d = 1) => (n * 100).toFixed(d) + '%';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r2 = (n) => Math.round(n * 100) / 100;

/* SHA-256 over a UTF-8 string (constants generated at build precision). */
const K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const l = bytes.length, bitLen = l * 8;
  const padded = new Uint8Array(Math.ceil((l + 9) / 64) * 64);
  padded.set(bytes); padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0); dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
  let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h = h.map((v, i) => (v + [a, b, c, d, e, f, g, hh][i]) >>> 0);
  }
  return h.map((v) => ('00000000' + v.toString(16)).slice(-8)).join('');
}

/* Farm economics at the current slider scenario (same formula as the model). */
const state = { dep: R.farm_rule.deposit_frac, drop: R.farm_rule.drop_share, hor: R.farm_rule.horizon_weeks, verdict: 'All', tier: 'All', cat: 'All', chain: 'All', q: '', sort: 'rank', dir: 1 };
function econ(row) {
  const dep = Math.round(state.dep * row.tvl_usd);
  const drop = row.implied_value_usd * state.drop * dep / (row.tvl_usd + dep);
  const gas = R.farm_rule.gas_base + R.farm_rule.gas_weekly * state.hor;
  const net = drop - gas;
  const tbill = dep * R.farm_rule.tbill_rate * (state.hor / 52);
  const hours = (R.farm_rule.setup_min + R.farm_rule.weekly_min * state.hor) / 60;
  const perHour = net / hours;
  const verdict = net > tbill && perHour > R.farm_rule.wage_per_hour ? 'Farm' : net > 0 ? 'Marginal' : 'Skip';
  return { dep, drop, gas, net, tbill, hours, perHour, verdict };
}
function ageStr(d) {
  if (d == null) return 'unknown';
  return d < 365 ? (d / 365).toFixed(1) + ' yr' : (d / 365).toFixed(1) + ' yr';
}
function verdictCounts() {
  const c = { Farm: 0, Marginal: 0, Skip: 0 };
  for (const r of R.rows) c[econ(r).verdict]++;
  return c;
}

/* KPI cards — every comparison is against the flat baseline, never a target. */
function renderKpis() {
  const v = R.value, o = R.odds, c = verdictCounts();
  const keptV = v.terms.filter((t) => t.kept).length, testV = v.terms.filter((t) => t.added !== 'control' && t.added !== 'baseline').length;
  const keptO = o.terms.filter((t) => t.kept).length, testO = o.terms.filter((t) => t.added !== 'control' && t.added !== 'baseline').length;
  $('kpis').innerHTML = [
    ['Out-of-sample miss, walk-forward', '×' + v.wf66.meanX.toFixed(2) + ' vs ×' + v.flat.wf66MeanX.toFixed(2) + ' flat', 'LOO ×' + v.loo.meanX.toFixed(2) + ' vs ×' + v.flat.looMeanX.toFixed(2) + ' · 5-fold ×' + v.fold5.meanX.toFixed(2) + ' · 47/48 ×' + v.wf47.meanX.toFixed(2)],
    ['Is the printed range honest?', fmtPct(v.looP2575, 0) + ' · ' + fmtPct(v.looP1090, 0) + ' inside P25–P75 · P10–P90', 'Stated 50% · 80% · WF ' + fmtPct(v.wfP2575, 0) + ' · ' + fmtPct(v.wfP1090, 0) + ' · within ×3: ' + fmtPct(v.looWithin3, 0) + ' / ' + fmtPct(v.wfWithin3, 0)],
    ['Token odds vs base rate', 'Brier ' + o.wfBrier + ' vs ' + o.wfBaseBrier + ' walk-forward', '10-fold Brier ' + o.foldBrier + ' · AUC ' + o.foldAuc + ' / ' + o.wfAuc + ' WF · ' + o.positives + ' of ' + o.n + ' (' + fmtPct(o.baseRate, 0) + ')'],
    ['Terms that survived both tests', keptV + ' of ' + testV + ' · ' + keptO + ' of ' + testO, 'value model · token odds; the rest are below, not used'],
    ['Worth farming, this scenario', c.Farm + ' of 198', 'net beats a T-bill and $25 an hour; ' + c.Marginal + ' marginal, ' + c.Skip + ' skip'],
    ['Watchlist ranked ' + R.watchlist_size + ' / ' + R.watchlist_size, '198 rows in all', R.early_size + ' early rows below the $50.0M floor'],
  ].map(([t, b, s]) => `<div class="kpi"><span>${t}</span><b>${b}</b><small>${s}</small></div>`).join('');
  $('heroFarm').textContent = c.Farm;
}

/* Integrity strip — recomputed in this browser from the same data file. */
function renderIntegrity() {
  const rows = R.rows;
  const ranksOk = rows.every((r, i) => r.rank === i + 1);
  const monoOk = rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd);
  const tvl = rows.reduce((s, r) => s + r.tvl_usd, 0);
  const imp = rows.reduce((s, r) => s + r.implied_value_usd, 0);
  const totalsOk = tvl === R.totals.tvl_usd && imp === R.totals.implied_usd;
  const sum = sha256Hex(JSON.stringify(rows)).slice(0, 8);
  const sumOk = sum === R.checksum;
  const watchOk = rows.filter((r) => r.watch).length === R.watchlist_size;
  const led = R.ledger;
  const ledOk = led.ranked_watchlist + led.ranked_early + led.token_priced + led.token_no_cap + led.out_not_ranked === led.total;
  const tick = (ok) => ok ? '✓' : '✗';
  $('integrity').innerHTML = `this table = board.json: ${rows.length} of ${rows.length} rows recomputed here ${tick(ranksOk)} ranks 1–${rows.length}, values never rise ${tick(monoOk)} totals ${fmt$(imp)} ${tick(totalsOk)} checksum ${R.checksum} = recomputed ${tick(sumOk)} watchlist ${R.watchlist_size}/${R.watchlist_size} ${tick(watchOk)} ledger ${led.total}/${led.total} ${tick(ledOk)}`;
}

/* Size-curve chart: fitted multiple vs TVL, with the 95 labelled dots. */
function renderCurve() {
  const v = R.value;
  const W = 640, H = 78, pl = 46, pr = 8, pt = 4, pb = 16;
  const xOf = (lt) => pl + ((lt - 6.7) / (10 - 6.7)) * (W - pl - pr);
  const yOf = (lr) => pt + ((1.2 - lr) / (1.2 - (-3))) * (H - pt - pb);
  let dots = '';
  for (const s of R.scatter) {
    const lt = Math.log10(s.tvl_usd), lr = Math.log10(s.ratio);
    if (lr < -3 || lr > 1.2) continue;
    dots += `<circle cx="${xOf(lt).toFixed(1)}" cy="${yOf(lr).toFixed(1)}" r="2.2" fill="#7c3aed" opacity="0.55"/>`;
  }
  let path = '';
  for (let lt = 6.7; lt <= 10.001; lt += 0.05) {
    const lr = v.intercept + v.slope * (lt - 8);
    path += (path ? ' L' : 'M') + xOf(lt).toFixed(1) + ' ' + yOf(lr).toFixed(1);
  }
  let grid = '';
  for (const lt of [7, 8, 9, 10]) grid += `<line x1="${xOf(lt)}" y1="${pt}" x2="${xOf(lt)}" y2="${H - pb}" stroke="#eef1f7"/><text x="${lt === 10 ? W - pr : xOf(lt)}" y="${H - 4}" font-size="10" fill="#5a6480" text-anchor="${lt === 10 ? 'end' : 'middle'}">${lt >= 9 ? '$' + Math.pow(10, lt - 9).toFixed(0) + 'B' : '$' + Math.pow(10, lt - 6).toFixed(0) + 'M'}</text>`;
  for (const lr of [-2, -1, 0, 1]) grid += `<line x1="${pl}" y1="${yOf(lr)}" x2="${W - pr}" y2="${yOf(lr)}" stroke="#eef1f7"/><text x="${pl - 4}" y="${yOf(lr) + 3}" font-size="10" fill="#5a6480" text-anchor="end">×${Math.pow(10, lr).toFixed(lr < 0 ? 2 : 0).replace(/\.00$/, '')}</text>`;
  $('curve').innerHTML = grid + dots + `<path d="${path}" fill="none" stroke="#4f46e5" stroke-width="2.5"/>`;
  $('curveNote').textContent = 'multiple at $100M TVL ×' + Math.pow(10, v.intercept).toFixed(2) + ' · slope ' + v.slope + ' ± ' + v.bootSlopeSe;
}

/* Board. */
function filteredRows() {
  let rows = R.rows.map((r) => ({ r, e: econ(r) }));
  if (state.verdict !== 'All') rows = rows.filter((x) => x.e.verdict === state.verdict);
  if (state.tier === 'Watchlist') rows = rows.filter((x) => x.r.watch);
  if (state.tier === 'Early') rows = rows.filter((x) => x.r.tvl_usd < R.floor_usd);
  if (state.tier === 'Off-list') rows = rows.filter((x) => !x.r.watch && x.r.tvl_usd >= R.floor_usd);
  if (state.cat !== 'All') rows = rows.filter((x) => (x.r.category ?? '—') === state.cat);
  if (state.chain !== 'All') rows = rows.filter((x) => x.r.chains.includes(state.chain));
  if (state.q) { const q = state.q.toLowerCase(); rows = rows.filter((x) => (x.r.name + ' ' + x.r.slug).toLowerCase().includes(q)); }
  const key = state.sort;
  rows.sort((a, b) => {
    const av = key === 'verdict' ? a.e.verdict : a.r[key];
    const bv = key === 'verdict' ? b.e.verdict : b.r[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av < bv ? -1 : av > bv ? 1 : a.r.rank - b.r.rank) * state.dir;
  });
  return rows;
}
function renderBoard() {
  const rows = filteredRows();
  const c = verdictCounts();
  $('countline').textContent = `${rows.length} of 198 rows · ${fmt$(R.rows.reduce((s, r) => s + r.tvl_usd, 0))} TVL · ${fmt$(R.totals.implied_usd)} implied · Farm ${c.Farm} / Marginal ${c.Marginal} / Skip ${c.Skip} at this scenario`;
  $('rows').innerHTML = rows.map(({ r, e }) => {
    const g = r.change_7d == null ? '–' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%';
    const tier = r.watch ? '<span class="tag">Watchlist</span>' : r.tvl_usd < R.floor_usd ? '<span class="tag early">Early</span>' : '<span class="tag early">Off-list</span>';
    return `<tr data-slug="${esc(r.slug)}"><td>${r.rank}<br><span style="font-size:11px;color:#5a6480">#${r.rank_lo}–${r.rank_hi}</span></td>` +
      `<td class="name"><b>${esc(r.name)}</b><span>${esc(r.category ?? '—')} · ${(r.chains || []).slice(0, 2).map(esc).join(', ') || '—'}</span>${tier}</td>` +
      `<td>${fmt$(r.tvl_usd)}</td><td>${g}</td><td>${ageStr(r.age_days)}</td>` +
      `<td>${fmtPct(r.token_odds, 0)}</td><td>${fmt$(r.if_launches_usd)}</td>` +
      `<td><b>${fmt$(r.implied_value_usd)}</b><br><span style="font-size:11px;color:#5a6480">${fmt$(r.p25_usd)}–${fmt$(r.p75_usd)}</span></td>` +
      `<td class="verdictcell"><span class="chip ${e.verdict}">${e.verdict}</span><br><span>net ${e.net >= 0 ? '+' : ''}${fmt$(e.net)} on ${fmt$(e.dep)}</span></td>` +
      `<td>${e.perHour >= 0 ? '+' : ''}$${e.perHour.toFixed(2)}/h</td></tr>`;
  }).join('');
  document.querySelectorAll('#rows tr').forEach((tr) => tr.addEventListener('click', () => openDrawer(tr.dataset.slug)));
}

/* Evidence tables. */
function renderEvidence() {
  const v = R.value, o = R.odds;
  $('vterms').innerHTML = `<tr><th>Term</th><th>Added in order</th><th class="num">Leave-one-out</th><th class="num">Walk-forward</th></tr>` +
    v.terms.map((t) => `<tr><td>${esc(t.term)}</td><td class="${t.kept ? 'kept' : 'notkept'}">${esc(t.added)}</td><td class="num">×${t.loo_mean} / ×${t.loo_med}</td><td class="num">×${t.wf_mean} / ×${t.wf_med}</td></tr><tr><td colspan="4" style="font-size:11.5px;color:#5a6480">${esc(t.note)}</td></tr>`).join('') +
    `<tr><td colspan="4" style="font-size:12px">Fitted, ± bootstrap s.e. (200 refits): multiple at $100M TVL ×${Math.pow(10, v.intercept).toFixed(2)} ± ${v.bootInterceptSe}, size slope ${v.slope} ± ${v.bootSlopeSe}; category effects ×${Math.pow(10, Math.min(...v.beta.slice(2))).toFixed(2)} to ×${Math.pow(10, Math.max(...v.beta.slice(2))).toFixed(2)} (largest s.e. ${v.catSeMax}).</td></tr>`;
  $('oterms').innerHTML = `<tr><th>Term</th><th>Added in order</th><th class="num">Ten-fold</th><th class="num">Walk-forward</th></tr>` +
    o.terms.map((t) => `<tr><td>${esc(t.term)}</td><td class="${t.kept ? 'kept' : 'notkept'}">${esc(t.added)}</td><td class="num">${t.fold_brier} (${Math.round(t.fold_auc * 100)}%)</td><td class="num">${t.wf_brier} (${Math.round(t.wf_auc * 100)}%)</td></tr><tr><td colspan="4" style="font-size:11.5px;color:#5a6480">${esc(t.note)}</td></tr>`).join('') +
    `<tr><td colspan="4" style="font-size:12px">Odds are the peers&rsquo; record (${o.positives} of ${o.n} record a token, more with each year listed), not a forecast: the page never says a token will launch.</td></tr>`;
  $('sweep').innerHTML = `<tr><th class="num">Ridge λ (pseudo-obs)</th><th class="num">LOO mean</th><th class="num">LOO median</th><th class="num">WF 66/29 mean</th><th class="num">WF 47/48 mean</th></tr>` +
    v.sweep.map((s) => `<tr${s.lam === v.lamCat ? ' style="background:#eef2ff;font-weight:700"' : ''}><td class="num">${s.lam}${s.lam === v.lamCat ? ' ← chosen' : ''}</td><td class="num">×${s.looMeanX}</td><td class="num">×${s.looMedX}</td><td class="num">×${s.wf66MeanX}</td><td class="num">×${s.wf47MeanX}</td></tr>`).join('');
  $('bootline').textContent = `The shrinkage is chosen by the lowest leave-one-out miss (λ = ${v.lamCat}); the whole sweep is shown, so the choice can be checked. Bootstrap s.e. on the fitted coefficients come from 200 refits of the 95 labelled protocols (seed 7).`;
  $('range').innerHTML = `<div class="kv"><div><b>${fmtPct(v.looP2575, 0)} · ${fmtPct(v.looP1090, 0)}</b><span>inside P25–P75 · P10–P90, leave-one-out (stated 50% · 80%)</span></div><div><b>${fmtPct(v.wfP2575, 0)} · ${fmtPct(v.wfP1090, 0)}</b><span>inside P25–P75 · P10–P90, walk-forward</span></div><div><b>${fmtPct(v.looWithin3, 0)} · ${fmtPct(v.wfWithin3, 0)}</b><span>within ×3 of the model, LOO · WF</span></div></div>`;
  const l = R.ledger;
  $('ledger').innerHTML = `All ${l.total} snapshot protocols in exactly one group: <b>${l.ranked_watchlist + l.ranked_early} ranked as pre-token</b> (${l.ranked_watchlist} watchlist · ${l.ranked_early} early, below the floor), <b>${l.token_priced + l.token_no_cap} already record a token</b> (${l.token_priced} priced · ${l.token_no_cap} no usable cap), <b>${l.out_not_ranked} left out</b> by the house list&rsquo;s own rules (pre-token, but not ranked).`;
  $('live').innerHTML = `<tr><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap ÷ TVL</th></tr>` +
    R.live.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.category ?? '—')}</td><td class="num">${fmt$(p.tvl_usd)}</td><td class="num">${fmt$(p.mcap_usd)}</td><td class="num">×${p.mcap_usd ? (p.mcap_usd / p.tvl_usd).toFixed(2) : '–'}</td></tr>`).join('');
}

/* Detail drawer. */
function openDrawer(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const v = R.value, o = R.odds, e = econ(r);
  const sizeMult = Math.pow(10, v.intercept + v.slope * (Math.log10(r.tvl_usd) - 8));
  const oddsWords = o.terms.filter((t) => t.kept).map((t) => t.term.startsWith('age') ? 'age' : t.term.startsWith('family') ? 'family' : t.term.startsWith('size') ? 'size' : t.term.startsWith('7-day') ? '7-day growth' : 'chain count');
  const oddsPhrase = oddsWords.length > 1 ? oddsWords.slice(0, -1).join(', ') + ' and ' + oddsWords[oddsWords.length - 1] : oddsWords[0];
  const gas = R.farm_rule.gas_base + R.farm_rule.gas_weekly * state.hor;
  const gridShares = [0.035, 0.07, 0.14], gridDeps = [1000, 10000, 30000];
  const grid = gridShares.map((sh) => gridDeps.map((dep) => {
    const drop = r.implied_value_usd * sh * dep / (r.tvl_usd + dep);
    const net = drop - gas;
    const hl = Math.abs(sh - state.drop) < 1e-9 && Math.abs(dep - e.dep) < Math.max(2000, e.dep * 0.5);
    return `<div class="${hl ? 'hl' : ''}"><b>${net >= 0 ? '+' : ''}${fmt$(net)}</b>${fmtPct(sh, 1)} × ${fmt$(dep)}</div>`;
  }).join('')).join('');
  const feeCoverShare = (gas / Math.max(1, r.implied_value_usd)) * (r.tvl_usd + e.dep) / Math.max(1, e.dep);
  $('drawerBody').innerHTML =
    `<h2>${esc(r.name)} <span style="font-size:13px;color:#5a6480">#${r.rank} of 198 · rank ${r.rank_lo}–${r.rank_hi} across 200 bootstrap refits</span></h2>` +
    `<p>Implied value <b>${fmt$(r.implied_value_usd)}</b> (model estimate); if a token launches <b>${fmt$(r.if_launches_usd)}</b>; token odds <b>${fmtPct(r.token_odds, 0)}</b>; P25–P75 ${fmt$(r.p25_usd)}–${fmt$(r.p75_usd)}; P10–P90 ${fmt$(r.p10_usd)}–${fmt$(r.p90_usd)}. Recomputed in this browser: equals board.json. DefiLlama records no token for it, which is not proof it has none; the odds are its peers&rsquo; record, not a forecast.</p>` +
    `<div class="kv"><div><b>${fmt$(r.tvl_usd)}</b><span>TVL · ${(r.chains || []).map(esc).join(', ')}</span></div><div><b>${fmtPct(r.token_odds, 0)}</b><span>token odds</span></div><div><b>×${r.multiple.toFixed(2)}</b><span>fitted multiple</span></div></div>` +
    `<h3>How the figure is made</h3><ol class="howto">` +
    `<li>TVL ${fmt$(r.tvl_usd)}.</li>` +
    `<li>Base multiple ×${Math.pow(10, v.intercept).toFixed(2)} (fitted on 95 traded tokens, read at $100M TVL; alone, a flat multiple: held-out miss ×${v.flat.looMeanX} leave-one-out, ×${v.flat.wf66MeanX} walk-forward).</li>` +
    `<li>Size curve (slope ${v.slope} ± ${v.bootSlopeSe}) → ×${sizeMult.toFixed(2)} (held-out miss ×${v.terms[1].loo_mean} / ×${v.terms[1].wf_mean}).</li>` +
    `<li>Category · ${esc(r.category ?? '—')}, ${r.category_priced} priced tokens, shrunk by ${v.lamCat} pseudo-observations → ×${Math.pow(10, r.category_effect).toFixed(2)} (held-out miss ×${v.loo.meanX} / ×${v.wf66.meanX}).</li>` +
    `<li>= value if a token launches ${fmt$(r.if_launches_usd)}; token odds ×${r.token_odds.toFixed(2)} (peers of its ${oddsPhrase}; base rate, walk-forward: Brier ${o.wfBrier} vs ${o.wfBaseBrier}) → implied value ${fmt$(r.implied_value_usd)}.</li></ol>` +
    `<p class="evnote">Tested, not used: family effect (×${v.terms[3].loo_mean}, ×${v.terms[3].wf_mean}), 7-day TVL growth (×${v.terms[4].loo_mean}, ×${v.terms[4].wf_mean}), age (×${v.terms[5].loo_mean}, ×${v.terms[5].wf_mean}), chain count (×${v.terms[6].loo_mean}, ×${v.terms[6].wf_mean}).</p>` +
    `<h3>Farm verdict — ${e.verdict}</h3>` +
    `<p><b>${fmt$(e.dep)}</b> for ${state.hor} weeks buys a modelled drop of <b>${fmt$(e.drop)}</b> for <b>${fmt$(e.gas)}</b> of fees and <b>${e.hours.toFixed(1)} h</b> of work, a net of <b>${e.net >= 0 ? '+' : ''}${fmt$(e.net)} (${e.perHour >= 0 ? '+' : ''}$${e.perHour.toFixed(2)} an hour)</b> against <b>${fmt$(e.tbill)}</b> from the same money in a 4% T-bill. Fees are covered while the drop share stays above ${fmtPct(Math.min(1, feeCoverShare), 1)} (model ${fmtPct(state.drop, 1)}) and the token odds above ${fmtPct(Math.min(1, (gas / Math.max(1, r.if_launches_usd)) * (r.tvl_usd + e.dep) / Math.max(1, e.dep) / Math.max(0.001, state.drop)), 1)} (peers imply ${fmtPct(r.token_odds, 1)}).</p>` +
    `<div class="grid3">${grid}</div>` +
    `<p class="evnote">Net by drop-share × deposit. Benchmarks: same ${fmt$(e.dep)} in a 4% T-bill, ${state.hor} weeks, ${fmt$(e.tbill)}; drop if a token does launch (odds not applied) ${fmt$(r.if_launches_usd * state.drop * e.dep / (r.tvl_usd + e.dep))}; exit if TVL prints below ${fmtInt(r.exit_tvl_usd)}. Formula: drop = implied value × drop share × deposit ÷ (TVL + deposit). ${e.verdict === 'Farm' ? 'FARM: the net beats the T-bill and $25 an hour.' : e.verdict === 'Marginal' ? 'MARGINAL: the net is positive but does not beat both bars.' : 'SKIP: the net does not beat the T-bill and $25 an hour.'} Yield earned meanwhile is left out.</p>` +
    `<h3>Farm plan — 10 steps</h3><ol class="steps">` +
    r.plan.map((s, i) => `<li><b>Step ${i + 1}.</b> ${esc(s.text)}<span>Cost: ${esc(s.cost)}. Time: ${esc(s.time)}.</span></li>`).join('') + `</ol>` +
    `<h3>Nearest priced peers · their tokens trade</h3><table class="mini"><tr><th>Token</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap ÷ TVL</th><th class="num">Cap ÷ held-out model</th></tr>` +
    r.peers.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.category ?? '—')}</td><td class="num">${fmt$(p.tvl_usd)}</td><td class="num">${fmt$(p.mcap_usd)}</td><td class="num">×${p.cap_per_tvl}</td><td class="num">×${p.cap_per_model}</td></tr>`).join('') + `</table>`;
  $('drawer').hidden = false;
  history.replaceState(null, '', '#detail=' + slug);
}
function closeDrawer() { $('drawer').hidden = true; history.replaceState(null, '', location.pathname + location.search); }

/* Wiring. */
function initFilters() {
  const cats = [...new Set(R.rows.map((r) => r.category ?? '—'))].sort();
  $('cat').innerHTML = '<option value="All">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('chain').innerHTML = '<option value="All">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
}
function bind() {
  $('dep').addEventListener('input', (ev) => { state.dep = parseFloat(ev.target.value); $('depVal').textContent = (state.dep * 100).toFixed(3) + '%'; renderKpis(); renderBoard(); });
  $('drop').addEventListener('input', (ev) => { state.drop = parseFloat(ev.target.value); $('dropVal').textContent = (state.drop * 100).toFixed(1) + '%'; renderKpis(); renderBoard(); });
  $('hor').addEventListener('input', (ev) => { state.hor = parseInt(ev.target.value, 10); $('horVal').textContent = state.hor + ' wk'; document.querySelector('.gas').textContent = `Gas budget $${(R.farm_rule.gas_base + R.farm_rule.gas_weekly * state.hor).toFixed(2)} over ${state.hor} weeks · T-bill 4% · $25/h bar`; renderKpis(); renderBoard(); });
  document.querySelectorAll('#verdictFilters button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#verdictFilters button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.verdict = b.dataset.v; renderBoard();
  }));
  $('tier').addEventListener('change', (ev) => { state.tier = ev.target.value; renderBoard(); });
  $('cat').addEventListener('change', (ev) => { state.cat = ev.target.value; renderBoard(); });
  $('chain').addEventListener('change', (ev) => { state.chain = ev.target.value; renderBoard(); });
  $('q').addEventListener('input', (ev) => { state.q = ev.target.value; renderBoard(); });
  $('resetBtn').addEventListener('click', () => {
    Object.assign(state, { dep: R.farm_rule.deposit_frac, drop: R.farm_rule.drop_share, hor: R.farm_rule.horizon_weeks, verdict: 'All', tier: 'All', cat: 'All', chain: 'All', q: '', sort: 'rank', dir: 1 });
    $('dep').value = state.dep; $('drop').value = state.drop; $('hor').value = state.hor;
    $('depVal').textContent = '0.020%'; $('dropVal').textContent = '7.0%'; $('horVal').textContent = '12 wk';
    $('tier').value = 'All'; $('cat').value = 'All'; $('chain').value = 'All'; $('q').value = '';
    document.querySelectorAll('#verdictFilters button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'All'));
    renderKpis(); renderBoard();
  });
  document.querySelectorAll('#board th').forEach((th) => th.addEventListener('click', () => {
    const s = th.dataset.s;
    if (state.sort === s) state.dir = -state.dir; else { state.sort = s; state.dir = 1; }
    renderBoard();
  }));
  $('csvBtn').addEventListener('click', () => {
    const head = 'rank,name,category,tvl_usd,change_7d,age_days,token_odds,if_launches_usd,implied_value_usd,verdict,net_usd,net_per_hour_usd\n';
    const body = filteredRows().map(({ r, e }) => [r.rank, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category ?? '') + '"', r.tvl_usd, r.change_7d ?? '', r.age_days ?? '', r.token_odds, r.if_launches_usd, r.implied_value_usd, e.verdict, e.net.toFixed(2), e.perHour.toFixed(2)].join(',')).join('\n');
    download(new Blob([head + body], { type: 'text/csv' }), 'launch-odds-radar-v14.csv');
  });
  $('jsonBtn').addEventListener('click', () => download(new Blob([JSON.stringify(filteredRows().map((x) => x.r), null, 2)], { type: 'application/json' }), 'launch-odds-radar-v14.json'));
  $('drawerClose').addEventListener('click', closeDrawer);
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

renderKpis(); renderIntegrity(); renderCurve(); initFilters(); renderEvidence(); renderBoard(); bind();
(function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('verdict')) {
    const v = h.get('verdict');
    state.verdict = v;
    document.querySelectorAll('#verdictFilters button').forEach((x) => x.classList.toggle('on', x.dataset.v === v));
    renderKpis(); renderBoard();
  }
  if (h.get('detail')) openDrawer(h.get('detail'));
})();
