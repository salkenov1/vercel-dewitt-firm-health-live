(function(){const D=window.SAMPLE_DATA,calcs={},cbs=[];const dk=()=>{const t=document.documentElement.dataset.theme;return t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches};
const L=['#0071e3','#af52de','#34c759','#ff9500','#ff2d55','#5ac8fa','#a2845e','#8e8e93'],K=['#2997ff','#bf5af2','#30d158','#ff9f0a','#ff375f','#64d2ff','#ac8e68','#98989d'];
let P={preset:'ytd',start:null,end:null};const fire=()=>cbs.forEach(f=>{try{f()}catch(e){console.error(e)}});
const ok=(d)=>({status:'ok',data:d,columns:Object.keys(d[0]||{}),meta:[]});
window.dash={get colors(){return dk()?K:L},data(id){const c=calcs[id];if(c){if(!c.cache)c.cache=c.fn(...c.inputs.map(i=>dash.data(i).data));return ok(c.cache)}return D[id]?ok(D[id]):{status:'missing',data:[],columns:[],meta:[]}},
calc(id,o){calcs[id]={...o}},loader(){},onData(f){cbs.push(f);try{f()}catch(e){console.error(e)}},params(){return{...P}},setParams(p){P={...P,...p};fire()},resetParams(){P={preset:'ytd',start:null,end:null};fire()},
setLink(n){const go=()=>{try{history.replaceState(null,'','#'+n)}catch(e){}};document.readyState==='complete'?go():addEventListener('load',()=>setTimeout(go,0),{once:true})},refresh(){}};
let t;addEventListener('resize',()=>{clearTimeout(t);t=setTimeout(fire,150)});matchMedia('(prefers-color-scheme: dark)').addEventListener('change',fire);new MutationObserver(fire).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});})();


// ---------- calculations (readers see these) ----------
dash.calc('kpi_delta', {
  title: 'KPI change vs prior period',
  description: 'Relative change of each KPI against the period before it.',
  inputs: ['kpis'],
  fn: (kpis) => kpis.filter((r) => r.prev != null && Number(r.prev) !== 0).map((r) => ({ metric: r.metric, delta: (Number(r.value) - Number(r.prev)) / Number(r.prev) })),
});
dash.calc('funnel', {
  title: 'Lead funnel totals',
  description: 'Leads, wanted and signed summed over all marketing sources.',
  inputs: ['marketing_sources'],
  fn: (marketing_sources) => [
    { step: 'Leads', n: marketing_sources.reduce((s, r) => s + Number(r.leads), 0) },
    { step: 'Wanted', n: marketing_sources.reduce((s, r) => s + Number(r.wanted), 0) },
    { step: 'Signed', n: marketing_sources.reduce((s, r) => s + Number(r.signed), 0) },
  ],
});
dash.calc('aging', {
  title: 'Stage aging counts',
  description: 'Active cases whose days in stage exceed the threshold the firm set for that stage.',
  inputs: ['case_list'],
  fn: (case_list) => [['Pre Suit', 90], ['Pending Litigation', 30], ['Litigation Initiated', 30], ['Service', 60], ['Pending Response', 30], ['Litigation Discovery', 120], ['Mediation', 120], ['Trial', 0]]
    .map(([stage, threshold]) => ({ stage, threshold, cases: case_list.filter((r) => r.stage === stage && Number(r.days_in_stage) > threshold).length })),
});
dash.calc('daily_calc', {
  title: 'Daily ratios and year-to-date totals',
  description: 'Per day: ratio metrics for that day, and running totals and ratios from Jan 1 of that year to that day.',
  inputs: ['metrics_daily'],
  fn: (metrics_daily) => {
    const sums = ['revenue', 'costs', 'personnel', 'marketing', 'ga', 'fees_collected', 'cases_signed', 'leads', 'wanted_leads', 'ad_spend_google', 'ad_spend_meta', 'demands_sent', 'cases_settled'];
    const ratios = [
      ['operating_margin', (r) => r.revenue - r.costs, (r) => r.revenue],
      ['personnel_pct', (r) => r.personnel, (r) => r.revenue],
      ['marketing_pct', (r) => r.ad_spend_google + r.ad_spend_meta, (r) => r.revenue],
      ['ga_pct', (r) => r.ga, (r) => r.revenue],
      ['cac', (r) => r.ad_spend_google + r.ad_spend_meta, (r) => r.cases_signed],
      ['wanted_signed_pct', (r) => r.cases_signed, (r) => r.wanted_leads],
    ];
    const rows = metrics_daily.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'day' ? v : Number(v)]))).sort((a, b) => (a.day < b.day ? -1 : 1));
    let year = null, acc = {};
    return rows.map((r) => {
      if (r.day.slice(0, 4) !== year) { year = r.day.slice(0, 4); acc = Object.fromEntries(sums.map((k) => [k, 0])); }
      sums.forEach((k) => { acc[k] += r[k]; });
      const out = { day: r.day, ad_spend_total: r.ad_spend_google + r.ad_spend_meta };
      ratios.forEach(([k, n, d]) => { out[k] = d(r) ? n(r) / d(r) : null; out['ytd_' + k] = d(acc) ? n(acc) / d(acc) : null; });
      sums.forEach((k) => { out['ytd_' + k] = acc[k]; });
      out.ytd_ad_spend_total = acc.ad_spend_google + acc.ad_spend_meta;
      return out;
    });
  },
});

;

// ---------- helpers ----------
const money = (v) => v == null ? '—' : (Math.abs(v) >= 10000 ? new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(v) : new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v));
const moneyFull = (v) => v == null ? '—' : new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
const pct = d3.format('.1%'), int = d3.format(','), day = d3.utcFormat('%b %-d'), mon = d3.utcFormat('%b');
const fmtBy = { '$': money, '%': pct, 'n': int, 'd': (v) => int(v) + ' d' };
const LOWER_BETTER = new Set(['costs_ytd', 'costs_mtd', 'personnel_pct', 'marketing_pct', 'ga_pct', 'avg_file_days', 'cac', 'cost_per_wanted', 'no_activity_30', 'treat_over_80', 'settled_not_disbursed', 'sol_6m', 'open_demands_30', 'contact_overdue']);
const ok = (id) => dash.data(id).status === 'ok';
const rows = (id) => ok(id) ? dash.data(id).data : [];
const kpiRow = (m) => rows('kpis').find((r) => r.metric === m);
const cur = (el) => getComputedStyle(el);
let tipEl;
const tip = (box, html, x, y) => {
  if (!tipEl || tipEl.parentNode !== box) { tipEl = document.createElement('div'); tipEl.className = 'fh-tip'; box.appendChild(tipEl); }
  tipEl.innerHTML = html; tipEl.style.display = 'block';
  const w = tipEl.offsetWidth, bw = box.clientWidth;
  tipEl.style.left = Math.max(0, Math.min(x + 12, bw - w)) + 'px'; tipEl.style.top = Math.max(0, y - 36) + 'px';
};
const untip = () => { if (tipEl) tipEl.style.display = 'none'; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// tile: value from kpis, delta from kpi_delta
function tile(metric, opts = {}) {
  const r = kpiRow(metric), d = rows('kpi_delta').find((x) => x.metric === metric);
  const cls = ['fh-tile', opts.alert ? 'alert' : '', opts.click ? 'click' : ''].join(' ');
  const f = fmtBy[r ? r.unit : 'n'];
  let delta = '';
  if (d) {
    const up = d.delta >= 0, good = LOWER_BETTER.has(metric) ? !up : up;
    delta = `<span class="fh-delta ${good ? 'good' : 'bad'}" data-source="kpi_delta" data-field="delta" data-where="metric=${metric}">${up ? '▲' : '▼'} ${pct(Math.abs(d.delta))}</span>`;
  }
  return `<div class="${cls}" id="k-${metric}" ${opts.click ? `role="button" tabindex="0" data-stage="${esc(opts.click)}" aria-pressed="false"` : ''}>
    <span class="lbl">${esc(opts.label || (r ? r.label : metric))}</span>
    <span class="val ${r ? '' : 'dash-skeleton'}" data-source="kpis" data-field="value" data-where="metric=${metric}">${r ? f(Number(r.value)) : '—'}</span>
    <span class="win">${r ? esc(r.window) : ''} ${delta}</span></div>`;
}
function tiles(el, list) { document.getElementById(el).innerHTML = list.map((x) => Array.isArray(x) ? tile(x[0], x[1]) : tile(x)).join(''); }

// table with sort and optional search
const sortState = {};
function table(id, data, cols, filterFn, cap) {
  const t = document.getElementById(id), body = t.querySelector('tbody'), th = [...t.querySelectorAll('th')];
  const s = sortState[id];
  let list = filterFn ? data.filter(filterFn) : data.slice();
  if (s) list.sort((a, b) => { const x = a[s.f], y = b[s.f]; const c = typeof x === 'number' || typeof y === 'number' ? (Number(x) || 0) - (Number(y) || 0) : String(x ?? '').localeCompare(String(y ?? '')); return s.dir === 'asc' ? c : -c; });
  th.forEach((h) => { h.setAttribute('aria-sort', s && s.f === h.dataset.field ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'); if (!h.dataset.bound) { h.dataset.bound = '1'; h.addEventListener('click', () => { const f = h.dataset.field; const c = sortState[id]; sortState[id] = { f, dir: c && c.f === f && c.dir === 'desc' ? 'asc' : 'desc' }; draw(); }); } });
  const key = t.dataset.rowKey;
  const keyOf = (r) => (key.includes(',') ? key.split(',').map((k) => encodeURIComponent(r[k])).join(',') : r[key]);
  body.innerHTML = (cap ? list.slice(0, cap) : list).map((r) => `<tr data-key="${esc(keyOf(r))}">` + cols.map((c) => `<td class="${c.num ? 'num' : ''}">${r[c.f] == null ? '—' : esc(c.fmt ? c.fmt(r[c.f]) : r[c.f])}</td>`).join('') + '</tr>').join('');
  return list.length;
}

// ---------- charts (d3 v7) ----------
function frame(box, h) {
  const w = box.clientWidth || 320; box.style.minHeight = h + 'px';
  box.querySelectorAll('svg, .fh-legend').forEach((s) => s.remove());
  const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('width', '100%');
  return { svg, w, h };
}
function textW(svg, s) { const t = svg.append('text').text(s); const w = t.node().getComputedTextLength(); t.remove(); return w || String(s).length * 6; }
const axisClean = (g) => g.attr('font-size', null).attr('font-family', null).call((g) => g.selectAll('.domain').attr('stroke', 'var(--cds-chart-axis)')).call((g) => g.selectAll('.tick line').attr('stroke', 'var(--cds-chart-grid)'));

// vertical bars, optional second series grouped
function bars(box, data, { x, series, fmt, color, label, cat = false }) {
  if (!data.length) return;
  const h = 240, m = { t: 12, r: 8, b: cat ? 60 : 32, l: 0 }; const { svg, w } = frame(box, h);
  const maxv = d3.max(data, (d) => d3.max(series, (s) => Number(d[s.f]))); const yTicks = d3.scaleLinear([0, maxv || 1], [0, 1]).ticks(4);
  m.l = d3.max(yTicks, (t) => textW(svg, fmt(t))) + 8;
  const X = d3.scaleBand(data.map((d) => d[x]), [m.l, w - m.r]).padding(0.25), Y = d3.scaleLinear([0, maxv || 1], [h - m.b, m.t]).nice();
  const g = svg.append('g');
  g.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(Y).ticks(4).tickFormat(fmt).tickSize(-(w - m.l - m.r))).call(axisClean);
  const ax = g.append('g').attr('transform', `translate(0,${h - m.b})`).call(d3.axisBottom(X).tickFormat(label || ((v) => v)).tickSize(0).tickPadding(10)).call(axisClean);
  if (cat) ax.selectAll('text').attr('transform', 'rotate(-35)').attr('text-anchor', 'end').attr('dx', '-4').attr('dy', '4');
  if (series.length > 1) { const lg = document.createElement('div'); lg.className = 'fh-legend'; lg.innerHTML = series.map((s, i) => `<span><i style="background:${s.color || color || dash.colors[i]}"></i>${esc(s.name)}</span>`).join(''); box.prepend(lg); }
  const inner = X.bandwidth() / series.length;
  series.forEach((s, i) => {
    g.selectAll(`.b${i}`).data(data).join('rect').attr('x', (d) => X(d[x]) + i * inner).attr('width', Math.min(32, inner - 2)).attr('y', (d) => Y(Number(d[s.f]))).attr('height', (d) => Y(0) - Y(Number(d[s.f]))).attr('rx', 4).attr('fill', s.color || color || dash.colors[i])
      .on('mousemove', (ev, d) => { const [px, py] = d3.pointer(ev, box); tip(box, `<div class="k">${esc(label ? label(d[x]) : d[x])}</div>` + series.map((t, j) => `<div><i class="sw" style="background:${t.color || color || dash.colors[j]}"></i>${esc(t.name)}: ${fmt(Number(d[t.f]))}</div>`).join(''), px, py); })
      .on('mouseleave', untip);
  });
}
// horizontal stacked bars (two series)
function hstack(box, data, { y, series, fmt, color }) {
  if (!data.length) return;
  const rowH = 30, m = { t: 6, r: 48, b: 24, l: 0 }, h = m.t + m.b + rowH * data.length; const { svg, w } = frame(box, h);
  m.l = d3.max(data, (d) => textW(svg, d[y])) + 10;
  const tot = (d) => series.reduce((s, k) => s + Number(d[k.f]), 0);
  const X = d3.scaleLinear([0, d3.max(data, tot) || 1], [m.l, w - m.r]), Y = d3.scaleBand(data.map((d) => d[y]), [m.t, h - m.b]).padding(0.3);
  svg.append('g').attr('transform', `translate(0,${h - m.b})`).call(d3.axisBottom(X).ticks(4).tickFormat(fmt).tickSize(-(h - m.t - m.b))).call(axisClean);
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(Y).tickSize(0)).call(axisClean).select('.domain').remove();
  data.forEach((d) => {
    let x0 = 0;
    series.forEach((s, i) => {
      const v = Number(d[s.f]);
      svg.append('rect').attr('x', X(x0)).attr('y', Y(d[y])).attr('width', X(x0 + v) - X(x0)).attr('height', Y.bandwidth()).attr('fill', color || dash.colors[i]).attr('rx', i === series.length - 1 ? 4 : 0)
        .on('mousemove', (ev) => { const [px, py] = d3.pointer(ev, box); tip(box, `<div class="k">${esc(d[y])}</div>` + series.map((t, j) => `<div><i class="sw" style="background:${dash.colors[j]}"></i>${esc(t.name)}: ${fmt(Number(d[t.f]))}</div>`).join('') + `<div>Total: ${fmt(tot(d))}</div>`, px, py); }).on('mouseleave', untip);
      x0 += v;
    });
    svg.append('text').attr('x', X(x0) + 6).attr('y', Y(d[y]) + Y.bandwidth() / 2).attr('dy', '0.35em').text(fmt(tot(d)));
  });
  if (series.length > 1) { const lg = document.createElement('div'); lg.className = 'fh-legend'; lg.innerHTML = series.map((s, i) => `<span><i style="background:${dash.colors[i]}"></i>${esc(s.name)}</span>`).join(''); box.prepend(lg); }
}
// lines over time, several series
function lines(box, data, { x, key, val, fmt, parse = (s) => new Date(s), tickFmt = day, area = false }) {
  if (!data.length) return;
  const h = 240, m = { t: 12, r: 8, b: 32, l: 0 }; const { svg, w } = frame(box, h);
  const ser = key ? [...new Set(data.map((d) => d[key]))] : ['value'];
  const byS = ser.map((s, i) => ({ name: s, color: dash.colors[i], pts: data.filter((d) => !key || d[key] === s).map((d) => ({ t: parse(d[x]), v: Number(d[val]) })).sort((a, b) => a.t - b.t) }));
  const maxv = d3.max(byS, (s) => d3.max(s.pts, (p) => p.v)), minv = Math.min(0, d3.min(byS, (s) => d3.min(s.pts, (p) => p.v)));
  const Y = d3.scaleLinear([minv, maxv || 1], [h - m.b, m.t]).nice();
  m.l = d3.max(Y.ticks(4), (t) => textW(svg, fmt(t))) + 8;
  const X = d3.scaleUtc(d3.extent(data, (d) => parse(d[x])), [m.l, w - m.r]);
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(Y).ticks(4).tickFormat(fmt).tickSize(-(w - m.l - m.r))).call(axisClean);
  svg.append('g').attr('transform', `translate(0,${h - m.b})`).call(d3.axisBottom(X).ticks(Math.max(2, Math.floor((w - m.l) / 80))).tickFormat(tickFmt).tickSize(0).tickPadding(10)).call(axisClean);
  const line = d3.line().x((p) => X(p.t)).y((p) => Y(p.v));
  byS.forEach((s, i) => {
    if (area && byS.length === 1) {
      const gid = `g-${box.id}`; const grad = svg.append('defs').append('linearGradient').attr('id', gid).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
      [[0, .26], [.25, .16], [.5, .08], [.75, .03], [1, 0]].forEach(([o, a]) => grad.append('stop').attr('offset', o).attr('style', `stop-color:${s.color};stop-opacity:${a}`));
      svg.append('path').attr('d', d3.area().x((p) => X(p.t)).y0(Y(minv)).y1((p) => Y(p.v))(s.pts)).attr('fill', `url(#${gid})`);
    }
    svg.append('path').attr('d', line(s.pts)).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
    const last = s.pts[s.pts.length - 1];
    svg.append('circle').attr('cx', X(last.t)).attr('cy', Y(last.v)).attr('r', 3).attr('fill', s.color);
  });
  const hover = svg.append('g').style('display', 'none'); const rule = hover.append('line').attr('y1', m.t).attr('y2', h - m.b).attr('stroke', 'var(--cds-chart-reference)');
  const dots = byS.map((s) => hover.append('circle').attr('r', 4).attr('fill', s.color));
  svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', w - m.l - m.r).attr('height', h - m.t - m.b).attr('fill', 'transparent')
    .on('mousemove', (ev) => { const [px, py] = d3.pointer(ev, box); const t = X.invert(px); const idx = d3.bisector((p) => p.t).center(byS[0].pts, t); const t0 = byS[0].pts[idx].t; hover.style('display', null); rule.attr('x1', X(t0)).attr('x2', X(t0));
      byS.forEach((s, i) => { const p = s.pts[Math.min(idx, s.pts.length - 1)]; dots[i].attr('cx', X(p.t)).attr('cy', Y(p.v)); });
      tip(box, `<div class="k">${tickFmt === mon ? d3.utcFormat('%b %Y')(t0) : d3.utcFormat('%b %-d, %Y')(t0)}</div>` + byS.map((s, i) => `<div>${byS.length > 1 ? `<i class="sw" style="background:${s.color}"></i>${esc(s.name)}: ` : ''}${fmt(s.pts[Math.min(idx, s.pts.length - 1)].v)}</div>`).join(''), px, py); })
    .on('mouseleave', () => { hover.style('display', 'none'); untip(); });
  if (byS.length > 1) { const lg = document.createElement('div'); lg.className = 'fh-legend'; lg.innerHTML = byS.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join(''); box.prepend(lg); }
}
function funnel(box, data) {
  if (!data.length) return;
  const rowH = 44, h = rowH * data.length + 8, { svg, w } = frame(box, h);
  const X = d3.scaleLinear([0, Number(data[0].n) || 1], [0, w - 120]);
  data.forEach((d, i) => {
    const y = i * rowH + 4, v = Number(d.n), prev = i ? Number(data[i - 1].n) : null;
    svg.append('rect').attr('x', 0).attr('y', y).attr('width', Math.max(2, X(v))).attr('height', rowH - 12).attr('rx', 4).attr('fill', i === data.length - 1 ? dash.colors[0] : 'var(--cds-chart-muted)');
    svg.append('text').attr('x', 6).attr('y', y + (rowH - 12) / 2).attr('dy', '0.35em').attr('fill', 'var(--color-fg)').text(`${d.step} · ${int(v)}`);
    if (prev) svg.append('text').attr('x', w - 4).attr('y', y + (rowH - 12) / 2).attr('dy', '0.35em').attr('text-anchor', 'end').text(`${pct(v / prev)} of previous`);
  });
}
function goalBars(el, items) {
  document.getElementById(el).innerHTML = items.map(([m, lbl, got, goal]) => { const r = kpiRow(m), g = kpiRow(got), t = kpiRow(goal); const v = r ? Number(r.value) : 0;
    return `<div><div class="fh-goal-top"><span>${lbl}</span><b data-source="kpis" data-field="value" data-where="metric=${m}">${r ? pct(v) : '—'}</b></div><div class="fh-bar"><i style="width:${Math.min(100, v * 100)}%"></i></div><div class="fh-goal-sub">${g ? money(Number(g.value)) : '—'} collected of ${t ? money(Number(t.value)) : '—'} goal</div></div>`; }).join('');
}

function drawTabs(sec) {
  if (sec === 'revenue') {
    tiles('rev-tiles', ['fees_mtd', 'fees_ytd', 'goal_month', 'goal_year', 'avg_fee_12m']);
    goalBars('rev-goals', [['goal_pct_month', 'This month', 'fees_mtd', 'goal_month'], ['goal_pct_year', 'This year', 'fees_ytd', 'goal_year']]);
    lines(document.getElementById('c-avgfee'), rows('monthly'), { x: 'month', val: 'avg_fee', fmt: money, parse: (s) => new Date(s + '-01'), tickFmt: mon, area: true });
    hstack(document.getElementById('c-feetype'), rows('fee_by_type'), { y: 'case_type', series: [{ f: 'avg_fee', name: 'Average fee' }], fmt: money });
    bars(document.getElementById('c-litrev'), rows('monthly'), { x: 'month', series: [{ f: 'litigation_revenue', name: 'Litigation' }, { f: 'non_litigation_revenue', name: 'Non-litigation' }], fmt: money, label: (m) => mon(new Date(m + '-01')) });
  }
  if (sec === 'intake') {
    tiles('intake-tiles', ['signed_month', 'signed_prior', 'signed_ytd', 'leads_total', 'leads_wanted', 'wanted_signed_pct']);
    funnel(document.getElementById('c-funnel'), rows('funnel'));
    table('t-intake', rows('intake_workers'), [{ f: 'worker' }, { f: 'leads_handled', num: 1, fmt: int }, { f: 'wanted', num: 1, fmt: int }, { f: 'signed', num: 1, fmt: int }, { f: 'wanted_signed_pct', num: 1, fmt: pct }, { f: 'wanted_signed_pct_prev', num: 1, fmt: pct }]);
  }
  if (sec === 'marketing') {
    tiles('mkt-tiles', ['cost_per_wanted']);
    table('t-sources', rows('marketing_sources'), [{ f: 'source' }, { f: 'leads', num: 1, fmt: int }, { f: 'wanted', num: 1, fmt: int }, { f: 'signed', num: 1, fmt: int }, { f: 'spend', num: 1, fmt: moneyFull }, { f: 'cost_per_wanted', num: 1, fmt: moneyFull }, { f: 'cost_per_signed', num: 1, fmt: moneyFull }, { f: 'lead_to_signed', num: 1, fmt: pct }, { f: 'wanted_to_signed', num: 1, fmt: pct }]);
    lines(document.getElementById('c-cps'), rows('cost_per_signed_daily'), { x: 'day', key: 'source', val: 'cost_per_signed', fmt: moneyFull });
  }
  if (sec === 'cases') {
    hstack(document.getElementById('c-stage'), rows('cases_by_stage'), { y: 'stage', series: [{ f: 'cases', name: 'Cases' }], fmt: int });
    hstack(document.getElementById('c-stagedays'), rows('cases_by_stage'), { y: 'stage', series: [{ f: 'avg_days', name: 'Avg days' }], fmt: (v) => int(v) + ' d', color: dash.colors[1] });
    tiles('case-alerts', [['no_activity_30', { alert: 1 }], ['treat_over_80', { alert: 1 }], ['settled_not_disbursed', { alert: 1 }], ['sol_6m', { alert: 1 }], 'demands_month', ['open_demands_30', { alert: 1 }], ['contact_overdue', { alert: 1 }]]);
    const ag = rows('aging');
    document.getElementById('case-aging').innerHTML = ag.map((r) => `<div class="fh-tile click" role="button" tabindex="0" data-stage="${esc(r.stage)}" data-thr="${r.threshold}" aria-pressed="${String(pickedStage === r.stage)}"><span class="lbl">${r.threshold ? `${esc(r.stage)} over ${r.threshold} days` : `In ${esc(r.stage).toLowerCase()} (any days)`}</span><span class="val" data-source="aging" data-field="cases" data-where="stage=${esc(r.stage)}">${int(r.cases)}</span><span class="win">cases</span></div>`).join('');
    const q = document.getElementById('dd-search').value.trim().toLowerCase();
    const n = table('t-cases', rows('case_list'), [{ f: 'case' }, { f: 'stage' }, { f: 'days_in_stage', num: 1, fmt: int }, { f: 'attorney' }, { f: 'case_manager' }, { f: 'case_type' }, { f: 'last_touch_days', num: 1, fmt: int }, { f: 'sol_days', num: 1, fmt: int }],
      (r) => (!pickedStage || (r.stage === pickedStage && Number(r.days_in_stage) > pickedThr)) && (!q || [r.case, r.attorney, r.case_manager, r.stage].join(' ').toLowerCase().includes(q)));
    document.getElementById('dd-title').textContent = pickedStage ? `${pickedStage}${pickedThr ? ` over ${pickedThr} days` : ''} — ${n} cases` : `Case list — ${n} cases`;
    document.getElementById('dd-note').textContent = pickedStage ? 'Click the tile again to clear the filter.' : 'All active cases in the sample. Click a stage-aging tile to filter.';
    hstack(document.getElementById('c-loadatt'), rows('load_by_attorney'), { y: 'attorney', series: [{ f: 'litigation', name: 'Litigation' }, { f: 'non_litigation', name: 'Non-litigation' }], fmt: int });
    hstack(document.getElementById('c-loadcm'), rows('load_by_cm'), { y: 'case_manager', series: [{ f: 'litigation', name: 'Litigation' }, { f: 'non_litigation', name: 'Non-litigation' }], fmt: int });
  }
  if (sec === 'highvalue') {
    tiles('hv-tiles', ['five_star', 'over_100k', 'surgery_scheduled', 'surgery_completed', 'tbi', 'catastrophic']);
    table('t-top25', rows('top25'), [{ f: 'rank', num: 1 }, { f: 'case' }, { f: 'attorney' }, { f: 'original_bills', num: 1, fmt: moneyFull }, { f: 'def1_limits', num: 1, fmt: moneyFull }, { f: 'um_uim_limits', num: 1, fmt: moneyFull }, { f: 'collectable', num: 1, fmt: moneyFull }, { f: 'indicators' }]);
  }
  if (sec === 'attorneys') {
    table('t-att', rows('attorney_perf'), [{ f: 'attorney' }, { f: 'fees_mtd', num: 1, fmt: moneyFull }, { f: 'fees_ytd', num: 1, fmt: moneyFull }, { f: 'avg_fee_ytd', num: 1, fmt: moneyFull }, { f: 'open_cases', num: 1, fmt: int }, { f: 'litigation', num: 1, fmt: int }, { f: 'non_litigation', num: 1, fmt: int }, { f: 'avg_case_age_days', num: 1, fmt: int }, { f: 'pending_lit_30', num: 1, fmt: int }, { f: 'service_30', num: 1, fmt: int }, { f: 'in_trial', num: 1, fmt: int }, { f: 'over_1y', num: 1, fmt: int }, { f: 'over_2y', num: 1, fmt: int }, { f: 'demands_sent', num: 1, fmt: int }, { f: 'cases_settled', num: 1, fmt: int }]);
    hstack(document.getElementById('c-attfees'), rows('attorney_perf'), { y: 'attorney', series: [{ f: 'fees_ytd', name: 'Fees YTD' }], fmt: money });
    hstack(document.getElementById('c-attage'), rows('attorney_perf'), { y: 'attorney', series: [{ f: 'avg_case_age_days', name: 'Avg case age' }], fmt: (v) => int(v) + ' d' });
  }
}
// ---------- metric definitions (shown in Data → Calculated metrics) ----------
const PIPE_FEE = 19500;
const DEFS = [
  { id: 'revenue', name: 'Total revenue', tab: 'Executive Scorecard', unit: '$', kind: 'sum', f: 'revenue', ytd: 'ytd_revenue', inputs: [],
    what: 'Total revenue for the year / for the month.',
    how: 'Sum of deposit lines posted to Revenue accounts, plus journal-entry lines on Revenue accounts (credit − debit), minus purchase lines posted to Revenue accounts (payments out of income, e.g. the Truist transfers), by transaction date. Day = that day’s total; scorecard = total over the selected period.',
    source: 'QuickBooks → <code>quickbooks.deposit</code> + <code>deposit_line</code>, <code>journal_entry</code> + <code>journal_entry_line</code>, <code>purchase_line</code>, <code>account</code>',
    filters: 'account.classification = Revenue · sales receipts to the trust account excluded · deleted rows excluded · transaction_date inside the period · cash basis and “DMG Marketing Fees” to confirm' },
  { id: 'costs', name: 'Total costs', tab: 'Executive Scorecard', unit: '$', kind: 'sum', f: 'costs', ytd: 'ytd_costs', inputs: [], lower: true,
    what: 'Total expenses for the year / for the month.',
    how: 'Sum of purchase lines, bill lines and journal-entry debits on Expense, Cost of Goods Sold and Other Expense accounts, by transaction date.',
    source: 'QuickBooks → <code>purchase_line</code>, <code>bill_line</code>, <code>journal_entry_line</code>, <code>account</code>',
    filters: 'account.classification = Expense · trust-account movements excluded · transaction_date inside the period' },
  { id: 'personnel', name: 'Personnel costs', tab: 'Executive Scorecard', unit: '$', kind: 'sum', f: 'personnel', ytd: 'ytd_personnel', inputs: [], lower: true,
    what: 'Total personnel costs (salaries, contract labor).',
    how: 'Sum of expense lines on accounts under “Personnel Expenses” (Payroll – Orlando, Payroll – Tampa, Contract Labor).',
    source: 'QuickBooks → expense lines + <code>account.fully_qualified_name</code>', filters: 'account path starts with “Personnel Expenses” · transaction_date inside the period' },
  { id: 'personnel_pct', name: 'Personnel cost as % of revenue', tab: 'Executive Scorecard', unit: '%', kind: 'ratio', calc: 'personnel_pct', ytd: 'ytd_personnel_pct', inputs: ['personnel', 'revenue'], lower: true,
    num: (r) => r.personnel, den: (r) => r.revenue,
    what: 'Personnel costs ÷ total revenue.', how: 'Personnel costs ÷ total revenue, both summed over the same period (not an average of daily ratios).',
    source: 'Built from Personnel costs and Total revenue', filters: 'Same period for numerator and denominator' },
  { id: 'marketing_pct', name: 'Marketing costs as % of revenue', tab: 'Executive Scorecard', unit: '%', kind: 'ratio', calc: 'marketing_pct', ytd: 'ytd_marketing_pct', inputs: ['ad_spend_google', 'ad_spend_meta', 'revenue'], lower: true,
    num: (r) => r.ad_spend_google + r.ad_spend_meta, den: (r) => r.revenue,
    what: 'Marketing costs ÷ total revenue.', how: '(Google Ads + Meta Ads spend) ÷ total revenue over the period. Alternative basis: QuickBooks “Marketing Expenses:Advertising” — the firm picks one.',
    source: 'Built from Marketing costs overview (Google Ads, Meta Ads) and Total revenue', filters: 'Same period for numerator and denominator' },
  { id: 'ga_pct', name: 'G&A costs as % of revenue', tab: 'Executive Scorecard', unit: '%', kind: 'ratio', calc: 'ga_pct', ytd: 'ytd_ga_pct', inputs: ['ga', 'revenue'], lower: true,
    num: (r) => r.ga, den: (r) => r.revenue,
    what: 'General expenses ÷ total revenue.', how: 'Expense lines on “General & Administrative Expenses:*” accounts ÷ total revenue over the period.',
    source: 'QuickBooks expense lines + Total revenue', filters: 'Account list to confirm with the firm' },
  { id: 'operating_margin', name: 'Operating margin', tab: 'Executive Scorecard', unit: '%', kind: 'ratio', calc: 'operating_margin', ytd: 'ytd_operating_margin', inputs: ['revenue', 'costs'],
    num: (r) => r.revenue - r.costs, den: (r) => r.revenue,
    what: 'Profit after all expenses — whether the firm is actually making money.', how: '(Total revenue − total costs) ÷ total revenue over the period.',
    source: 'Built from Total revenue and Total costs', filters: 'Same period for both' },
  { id: 'ad_spend_google', name: 'Google Ads spend', tab: 'Executive Scorecard', unit: '$', kind: 'sum', f: 'ad_spend_google', ytd: 'ytd_ad_spend_google', inputs: [], neutral: true,
    what: 'Marketing costs overview — Google Ads.', how: 'Sum of campaign cost per day across the three Google Ads accounts (cost_micros ÷ 1,000,000).',
    source: 'Google Ads via Fivetran → <code>google_ads.campaign_stats</code>, <code>google_ads2.campaign_stats</code>, <code>google_ads3.campaign_stats</code>', filters: 'date inside the period · all campaigns' },
  { id: 'ad_spend_meta', name: 'Meta Ads spend', tab: 'Executive Scorecard', unit: '$', kind: 'sum', f: 'ad_spend_meta', ytd: 'ytd_ad_spend_meta', inputs: [], neutral: true,
    what: 'Marketing costs overview — Meta (Facebook / Instagram).', how: 'Sum of spend per day across all ads.',
    source: 'Meta Ads via Fivetran → <code>facebook_ads.basic_ad</code>', filters: 'date inside the period · account 633331314677386' },
  { id: 'cac', name: 'Case acquisition cost', tab: 'Executive Scorecard', unit: '$', kind: 'ratio', calc: 'cac', ytd: 'ytd_cac', inputs: ['ad_spend_google', 'ad_spend_meta', 'cases_signed'], lower: true,
    num: (r) => r.ad_spend_google + r.ad_spend_meta, den: (r) => r.cases_signed,
    what: 'Cost to acquire one signed case.', how: '(Google Ads + Meta Ads spend) ÷ cases signed, both over the same period. Spend basis (ads vs QuickBooks marketing) to agree.',
    source: 'Ads spend + Lead Docket signed leads', filters: 'Same period · signed = Status “Signed Up” by SignedUpDate' },
  { id: 'fees_collected', name: 'Fees collected', tab: 'Revenue', unit: '$', kind: 'sum', f: 'fees_collected', ytd: 'ytd_fees_collected', inputs: [],
    what: 'Actual attorney fees received.', how: 'Sum of Lead Docket settlement fees (the firm’s fee: ⅓ pre-suit, 40% in litigation) by settlement date. CasePeer has no fee field. Alternative basis: QuickBooks deposits to Revenue accounts — the firm picks one.',
    source: 'Lead Docket → <code>settlements.Fee</code> (GET /settlements/getbyleadid/{id})', filters: 'settlement Date inside the period · Fee not null' },
  { id: 'cases_signed', name: 'Cases signed', tab: 'Intake', unit: 'n', kind: 'sum', f: 'cases_signed', ytd: 'ytd_cases_signed', inputs: [],
    what: 'Whether signed cases are increasing or decreasing.', how: 'Count of Lead Docket leads with Status = Signed Up, by SignedUpDate.',
    source: 'Lead Docket → <code>leaddocket_leads_basic</code>', filters: 'Status = Signed Up · SignedUpDate inside the period' },
  { id: 'leads', name: 'Total leads', tab: 'Intake', unit: 'n', kind: 'sum', f: 'leads', ytd: 'ytd_leads', inputs: [],
    what: 'Whether leads are increasing or decreasing.', how: 'Count of leads by CreatedDate.', source: 'Lead Docket → <code>leaddocket_leads_basic</code>', filters: 'CreatedDate inside the period' },
  { id: 'wanted_leads', name: 'Wanted leads', tab: 'Intake', unit: 'n', kind: 'sum', f: 'wanted_leads', ytd: 'ytd_wanted_leads', inputs: [],
    what: 'Whether wanted leads are increasing or decreasing.', how: 'Count of leads whose status is marked wanted, by CreatedDate.', source: 'Lead Docket → <code>leaddocket_leads_basic</code> + <code>leaddocket_statuses.IsWanted</code>', filters: 'IsWanted = true · CreatedDate inside the period' },
  { id: 'wanted_signed_pct', name: '% of wanted leads signed', tab: 'Intake', unit: '%', kind: 'ratio', calc: 'wanted_signed_pct', ytd: 'ytd_wanted_signed_pct', inputs: ['cases_signed', 'wanted_leads'],
    num: (r) => r.cases_signed, den: (r) => r.wanted_leads,
    what: 'Share of wanted leads that sign.', how: 'Cases signed ÷ wanted leads over the same period.', source: 'Lead Docket', filters: 'Same period for both' },
  { id: 'active_cases', name: 'Active cases', tab: 'Executive Scorecard', unit: 'n', kind: 'last', f: 'active_cases', inputs: [],
    what: 'Cases currently open — the base of the pipeline.', how: 'Count of CasePeer cases with caseclosed = false, taken from the daily snapshot. Scorecard shows the last day of the period.',
    source: 'CasePeer → <code>casepeer_cases</code> → daily snapshot <code>hist.cp_case_stage_daily</code>', filters: 'caseclosed = false' },
  { id: 'pipeline_value', name: 'Total pipeline value', tab: 'Executive Scorecard', unit: '$', kind: 'last', f: 'pipeline_value', inputs: ['active_cases'],
    what: 'Estimated fee value of all active cases; show if increasing or decreasing.', how: 'Active cases × average fee parameter ($19,500, fixed; the firm can change it). No probability weighting in phase 1.',
    source: 'Active cases + parameter table <code>params.avg_fee</code>', filters: 'caseclosed = false · value on the last day of the period' },
  { id: 'avg_fee_12m', name: 'Average fee per closed case', tab: 'Revenue', unit: '$', kind: 'last', f: 'avg_fee_12m', inputs: [],
    what: 'Whether case value is improving or declining.', how: 'Sum of Lead Docket settlement fees ÷ number of settled leads over the rolling last 12 months ending that day; recalculated daily.',
    source: 'Lead Docket → <code>settlements.Fee</code>', filters: 'settlement Date within 365 days before the day · Fee not null' },
  { id: 'avg_file_days', name: 'Average file time on desk', tab: 'Executive Scorecard', unit: 'd', kind: 'last', f: 'avg_file_days', inputs: [], lower: true,
    what: 'Average time from signing to closing a file.', how: 'Average of (CaseClosedDate − SignedUpDate) in days for leads closed in the selected period; compared with the prior period.',
    source: 'Lead Docket → <code>leaddocket_leads_basic</code> SignedUpDate, CaseClosedDate', filters: 'CaseClosedDate inside the period' },
  { id: 'demands_sent', name: 'Demands sent', tab: 'Case Progress', unit: 'n', kind: 'sum', f: 'demands_sent', ytd: 'ytd_demands_sent', inputs: [],
    what: 'Pre-suit production.', how: 'Count of demands by date sent.', source: 'CasePeer → <code>casepeer_demands.datesent</code>', filters: 'datesent inside the period' },
  { id: 'cases_settled', name: 'Cases settled', tab: 'Attorney Performance', unit: 'n', kind: 'sum', f: 'cases_settled', ytd: 'ytd_cases_settled', inputs: [],
    what: 'Number of cases resolved.', how: 'Count of cases that moved to Settled or Disbursed, by closed date.', source: 'CasePeer → <code>casepeer_cases</code>', filters: 'status = Settled / Disbursed · closed_date inside the period' },
  { id: 'no_activity_30', name: 'Cases with no activity in 30+ days', tab: 'Case Progress', unit: 'n', kind: 'last', f: 'no_activity_30', inputs: [], lower: true,
    what: 'Finds stalled files quickly.', how: 'Active cases whose latest note or update is older than 30 days, counted each day.', source: 'CasePeer → <code>casepeer_cases</code> + <code>casepeer_notes</code>', filters: 'caseclosed = false' },
  { id: 'sol_6m', name: 'SOL within 6 months', tab: 'Case Progress', unit: 'n', kind: 'last', f: 'sol_6m', inputs: [], lower: true,
    what: 'Critical executive risk control.', how: 'Active cases whose statute date is within 6 months of the day.', source: 'CasePeer → <code>casepeer_cases.statutedate</code>', filters: 'caseclosed = false' },
  { id: 'contact_overdue', name: 'Client contact overdue', tab: 'Case Progress', unit: 'n', kind: 'last', f: 'contact_overdue', inputs: [], lower: true,
    what: 'Prevents client complaints and service breakdowns.', how: 'Active cases whose last touch is older than N days (N set by the firm). Last touch = latest note in Client Communication, Email, Incoming SMS or Outgoing SMS.', source: 'CasePeer → <code>casepeer_notes</code> (created, note_categories)', filters: 'caseclosed = false' },
  { id: 'open_demands_30', name: 'Open demands over 30 days', tab: 'Case Progress', unit: 'n', kind: 'last', f: 'open_demands_30', inputs: [], lower: true,
    what: 'Flags negotiation follow-up issues.', how: 'Demands sent more than 30 days before the day and not accepted.', source: 'CasePeer → <code>casepeer_demands</code>', filters: 'offeraccepted = false · datesent < day − 30' },
];
const MASTER = { revenue: '#8 YTD, #9 MTD', costs: '#10 YTD, #11 MTD', personnel: '#12', personnel_pct: '#13', marketing_pct: '#15', ga_pct: '#16', operating_margin: '#17', ad_spend_google: '#14', ad_spend_meta: '#14', cac: '#21',
  fees_collected: '#22 MTD, #23 YTD', cases_signed: '#29, #30, #31', leads: '#32', wanted_leads: '#33', wanted_signed_pct: '#34', active_cases: 'input to #18', pipeline_value: '#18', avg_fee_12m: '#20, #26', avg_file_days: '#19',
  demands_sent: '#52, #82', cases_settled: '#83', no_activity_30: '#48', sol_6m: '#51', contact_overdue: '#54', open_demands_30: '#53' };
DEFS.forEach((d) => { d.master = MASTER[d.id] || '—'; });
const DEF = Object.fromEntries(DEFS.map((d) => [d.id, d]));
const FIELD_LABEL = { day: 'Day', revenue: 'Revenue', costs: 'Costs', personnel: 'Personnel', marketing: 'Marketing (QB)', ga: 'G&A', fees_collected: 'Fees collected', cases_signed: 'Cases signed', leads: 'Leads', wanted_leads: 'Wanted leads',
  ad_spend_google: 'Google Ads', ad_spend_meta: 'Meta Ads', active_cases: 'Active cases', pipeline_value: 'Pipeline value', avg_fee_12m: 'Avg fee 12m', avg_file_days: 'Avg file days', demands_sent: 'Demands sent', cases_settled: 'Cases settled',
  no_activity_30: 'No activity 30+', sol_6m: 'SOL ≤ 6 mo', contact_overdue: 'Contact overdue', open_demands_30: 'Open demands 30+', operating_margin: 'Operating margin', personnel_pct: 'Personnel %', marketing_pct: 'Marketing %', ga_pct: 'G&A %', cac: 'CAC', wanted_signed_pct: '% wanted signed' };
const UNIT_OF = (f) => (/_pct$|margin/.test(f) ? '%' : /revenue|costs|personnel|marketing$|^ga$|fees|spend|pipeline|avg_fee|cac/.test(f) ? '$' : f === 'avg_file_days' ? 'd' : 'n');

// ---------- raw sources (shown in Data → Raw data) ----------
const SOURCES = [
  { id: 'cp_cases', name: 'Cases', system: 'CasePeer', table: 'firm_health.casepeer_cases', key: 'case_id', dateDefault: '', dates: ['opened', 'closed', 'entered_litigation', 'statute_date', 'last_touch'], status: 'status', statusLabel: 'Case status',
    note: 'One row per case. Base of Case Progress, High Value and Attorney Performance. Medical bills, limits, rating, surgery and TBI fields are what the firm showed in the CasePeer UI — to verify in the Data Sync API.' },
  { id: 'cp_demands', name: 'Demands', system: 'CasePeer', table: 'firm_health.casepeer_demands', key: 'demand_id', dates: ['date_sent'], status: 'status', statusLabel: 'Status', note: 'One row per demand. Demands sent, open demands 30+, demands by attorney.' },
  { id: 'cp_offers', name: 'Offers', system: 'CasePeer', table: 'firm_health.casepeer_offers', key: 'offer_id', dates: ['offer_date', 'accepted_date'], status: 'status', statusLabel: 'Status', note: 'One row per offer. Fallback source for settlement fees (accepted amount × ⅓ or 40%).' },
  { id: 'ld_leads', name: 'Leads', system: 'Lead Docket', table: 'firm_health.leaddocket_leads_basic', key: 'lead_id', dates: ['created', 'signed_up_date'], status: 'status', statusLabel: 'Lead status', note: 'One row per lead from /leads/basic/{id}. Intake and Marketing tabs.' },
  { id: 'qb_deposits', name: 'Deposits', system: 'QuickBooks', table: 'quickbooks.deposit + deposit_line + account', key: 'deposit_id', dates: ['transaction_date'], status: 'account', statusLabel: 'Account', note: 'Deposit lines with their account. Revenue = lines on Revenue accounts.' },
  { id: 'qb_purchases', name: 'Purchases', system: 'QuickBooks', table: 'quickbooks.purchase + purchase_line + account', key: 'purchase_id', dates: ['transaction_date'], status: 'account', statusLabel: 'Account', note: 'Expense lines with their account. Costs, Personnel, Marketing, G&A.' },
  { id: 'gads_campaign_stats', name: 'Campaign stats', system: 'Google Ads', table: 'google_ads*.campaign_stats (3 accounts)', key: 'date,campaign', dates: ['date'], status: 'status', statusLabel: 'Campaign status', note: 'Daily cost, clicks and impressions per campaign.' },
  { id: 'meta_basic_ad', name: 'Basic ad', system: 'Meta Ads', table: 'facebook_ads.basic_ad', key: 'date,campaign', dates: ['date'], status: 'status', statusLabel: 'Ad status', note: 'Daily spend, clicks and impressions per ad.' },
];

const LIVE = window.LIVE_META || null, REG = window.REGISTRY || null;
const REG_SRC = { cp_cases: 'cp_cases', cp_demands: 'cp_demands', cp_offers: 'cp_offers', ld_leads: 'ld_basic', qb_deposits: 'qb_deposits', qb_purchases: 'qb_purchases', gads_campaign_stats: 'gads', meta_basic_ad: 'meta' };
const RAG_WORD = { green: 'Green', yellow: 'Yellow', red: 'Red' }, RAG_RANK = { red: 0, yellow: 1, green: 2 };
const dot = (st) => `<i class="fh-rag ${st}" aria-hidden="true"></i>`;
const ragPill = (st, text) => `<span class="fh-ragpill ${st}">${dot(st)}${esc(text || RAG_WORD[st])}</span>`;
const srcStatus = (id) => (REG && REG.sources.find((s) => s.id === (REG_SRC[id] || id)) || {}).status;
if (LIVE) SOURCES.forEach((s) => Object.assign(s, LIVE.tables[s.id] || {}));

// ---------- state ----------
let view = 'dashboard', current = 'exec', dtab = 'calc', src = 'cp_cases', metric = window.REGISTRY ? 'm8' : 'revenue', pickedStage = null, pickedThr = 0;
const rawState = { datecol: null, status: '', q: '' };
const iso = d3.utcFormat('%Y-%m-%d'), longDay = d3.utcFormat('%b %-d, %Y'), shortDay = d3.utcFormat('%b %-d');
const P = (s) => new Date(s + 'T00:00:00Z');
const addDays = (s, n) => iso(d3.utcDay.offset(P(s), n));
function anchor() { const r = rows('metrics_daily'); return r.length ? d3.max(r, (x) => x.day) : iso(new Date()); }
function range() {
  const p = dash.params(), end = (p.preset === 'custom' && p.end) || anchor(), preset = p.preset || 'ytd';
  let start = end.slice(0, 4) + '-01-01';
  if (preset === 'mtd') start = end.slice(0, 7) + '-01';
  if (preset === 'l30') start = addDays(end, -29);
  if (preset === 'l90') start = addDays(end, -89);
  if (preset === 'custom') start = p.start || start;
  return { start, end, preset };
}
const inR = (d, R) => d >= R.start && d <= R.end;
const fmtU = (u, v) => (v == null || Number.isNaN(v) ? '—' : u === '$' ? money(v) : u === '%' ? pct(v) : u === 'd' ? int(Math.round(v)) + ' d' : int(Math.round(v)));
const fmtCell = (u, v) => (v == null || Number.isNaN(Number(v)) ? '—' : u === '$' ? moneyFull(Number(v)) : u === '%' ? pct(Number(v)) : u === 'd' ? int(Math.round(Number(v))) : int(Number(v)));

// ---------- scorecard tiles with trend line ----------
function series(def, rs, mtdEnd) {
  let use = rs;
  if (mtdEnd) use = rs.filter((r) => r.day.slice(0, 7) === mtdEnd.slice(0, 7));
  const out = []; let a = 0, n = 0, d = 0;
  use.forEach((r) => {
    if (def.kind === 'sum') { a += Number(r[def.f]); out.push({ day: r.day, v: a }); }
    else if (def.kind === 'ratio') { n += def.num(r); d += def.den(r); out.push({ day: r.day, v: d ? n / d : null }); }
    else out.push({ day: r.day, v: Number(r[def.f]) });
  });
  return out;
}
function sparkline(box, pts, color) {
  const w = box.clientWidth || 160, h = 38; box.replaceChildren();
  const good = pts.filter((p) => p.v != null); if (good.length < 2) return;
  const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('preserveAspectRatio', 'none');
  const X = d3.scaleUtc(d3.extent(good, (p) => P(p.day)), [2, w - 4]);
  const ext = d3.extent(good, (p) => p.v), pad = (ext[1] - ext[0]) * 0.08 || 1;
  const Y = d3.scaleLinear([ext[0] - pad, ext[1] + pad], [h - 2, 3]);
  const gid = 'sg-' + box.id;
  const grad = svg.append('defs').append('linearGradient').attr('id', gid).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
  [[0, .32], [.5, .1], [1, 0]].forEach(([o, op]) => grad.append('stop').attr('offset', o).attr('style', `stop-color:${color};stop-opacity:${op}`));
  svg.append('path').attr('d', d3.area().x((p) => X(P(p.day))).y0(h).y1((p) => Y(p.v))(good)).attr('fill', `url(#${gid})`);
  svg.append('path').attr('d', d3.line().x((p) => X(P(p.day))).y((p) => Y(p.v))(good)).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.75).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
  const last = good[good.length - 1];
  svg.append('circle').attr('cx', X(P(last.day))).attr('cy', Y(last.v)).attr('r', 2.75).attr('fill', color);
  const dot = svg.append('circle').attr('r', 3).attr('fill', color).style('display', 'none');
  const tileEl = box.closest('.fh-tile'), def = DEF[box.dataset.def];
  svg.on('mousemove', (ev) => { const [px] = d3.pointer(ev); const t = X.invert(px); const i = d3.bisector((p) => P(p.day)).center(good, t); const p = good[i];
    dot.style('display', null).attr('cx', X(P(p.day))).attr('cy', Y(p.v)); const [tx, ty] = d3.pointer(ev, tileEl); tip(tileEl, `<div class="k">${longDay(P(p.day))}</div><div>${fmtU(def.unit, p.v)}</div>`, tx, ty); })
    .on('mouseleave', () => { dot.style('display', 'none'); untip(); });
}
function scoreTiles(el, ids, R) {
  const all = rows('metrics_daily'), cur = all.filter((r) => inR(r.day, R));
  const len = d3.utcDay.count(P(R.start), P(R.end)) + 1, pEnd = addDays(R.start, -1), pStart = addDays(R.start, -len);
  const prev = all.filter((r) => r.day >= pStart && r.day <= pEnd);
  const box = document.getElementById(el);
  box.innerHTML = ids.map((id) => {
    const mtd = id.endsWith('_mtd'), def = DEF[mtd ? id.replace('_mtd', '') : id];
    return `<div class="fh-tile" id="t-${id}" data-source="metrics_daily" style="position:relative">
      <span class="lbl">${esc(def.name)}${mtd ? ' · MTD' : ''}</span><span class="val ${cur.length ? '' : 'dash-skeleton'}" id="v-${id}">—</span>
      <span class="win" id="w-${id}"></span><div class="spark" id="s-${id}" data-def="${def.id}"></div></div>`;
  }).join('');
  if (!cur.length) return;
  ids.forEach((id, i) => {
    const mtd = id.endsWith('_mtd'), def = DEF[mtd ? id.replace('_mtd', '') : id];
    const pts = series(def, cur, mtd ? R.end : null), v = pts.length ? pts[pts.length - 1].v : null;
    document.getElementById('v-' + id).textContent = fmtU(def.unit, v);
    let win = mtd ? `${shortDay(P(R.end.slice(0, 7) + '-01'))} – ${shortDay(P(R.end))}` : def.kind === 'last' ? `on ${shortDay(P(R.end))}` : `${shortDay(P(R.start))} – ${shortDay(P(R.end))}`;
    let delta = '';
    if (!mtd && prev.length >= len * 0.9) {
      const pp = series(def, prev), pv = pp.length ? pp[pp.length - 1].v : null;
      if (pv && v != null) { const ch = (v - pv) / Math.abs(pv), up = ch >= 0, good = def.lower ? !up : up;
        delta = `<span class="fh-delta ${def.neutral ? '' : good ? 'good' : 'bad'}">${up ? '▲' : '▼'} ${pct(Math.abs(ch))} vs prior period</span>`; }
    }
    document.getElementById('w-' + id).innerHTML = `<span>${win}</span>${delta}`;
    sparkline(document.getElementById('s-' + id), pts, dash.colors[i % 4]);
  });
}
function drawExec(R) {
  scoreTiles('exec-money', ['revenue', 'revenue_mtd', 'costs', 'costs_mtd', 'operating_margin', 'pipeline_value'], R);
  scoreTiles('exec-eff', ['personnel', 'personnel_pct', 'marketing_pct', 'ga_pct', 'avg_file_days', 'avg_fee_12m', 'cac', 'active_cases', 'ad_spend_google', 'ad_spend_meta'], R);
  const cur = rows('metrics_daily').filter((r) => inR(r.day, R));
  const byM = d3.rollups(cur, (v) => ({ revenue: d3.sum(v, (r) => r.revenue), costs: d3.sum(v, (r) => r.costs) }), (r) => r.day.slice(0, 7)).map(([month, o]) => ({ month, ...o, margin: o.revenue ? (o.revenue - o.costs) / o.revenue : null })).sort((a, b) => (a.month < b.month ? -1 : 1));
  bars(document.getElementById('c-revcost'), byM, { x: 'month', series: [{ f: 'revenue', name: 'Revenue' }, { f: 'costs', name: 'Costs' }], fmt: money, label: (m) => mon(new Date(m + '-01')) });
  if (byM.length > 1) lines(document.getElementById('c-margin'), byM, { x: 'month', val: 'margin', fmt: pct, parse: (s) => new Date(s + '-01'), tickFmt: mon, area: true });
  else bars(document.getElementById('c-margin'), byM, { x: 'month', series: [{ f: 'margin', name: 'Margin' }], fmt: pct, label: (m) => mon(new Date(m + '-01')) });
  lines(document.getElementById('c-gads'), cur, { x: 'day', val: 'ad_spend_google', fmt: money, parse: P, area: true });
  lines(document.getElementById('c-meta'), cur, { x: 'day', val: 'ad_spend_meta', fmt: money, parse: P, area: true });
}

// ---------- Data → calculated metrics ----------
function fillPicker() {
  const box = document.getElementById('m-tags');
  if (!box.dataset.bound) {
    const tag = (id, name, st) => `<button class="fh-tag" data-metric="${id}" aria-pressed="false">${st ? dot(st) : ''}${esc(name)}</button>`;
    let html = `<div class="fh-taggroup"><span class="fh-taglbl">Overview</span><div class="fh-tagrow">${tag('all', 'All daily metrics')}</div></div>`;
    if (REG) {
      const c = REG.counts;
      html = `<div class="fh-taggroup"><span class="fh-taglbl">Overview</span><div class="fh-tagrow">${tag('all', 'All daily metrics')}<span class="fh-raglegend">${ragPill('green', `${c.green} ready`)}${ragPill('yellow', `${c.yellow} partial`)}${ragPill('red', `${c.red} source missing`)}</span></div></div>`
        + d3.groups(REG.metrics, (m) => m.tab).map(([tab, list]) => `<div class="fh-taggroup"><span class="fh-taglbl">${esc(tab)}</span><div class="fh-tagrow">${list.map((m) => tag('m' + m.n, `#${m.n} ${m.short}`, m.status)).join('')}</div></div>`).join('');
    } else html += d3.groups(DEFS, (d) => d.tab).map(([tab, list]) => `<div class="fh-taggroup"><span class="fh-taglbl">${esc(tab)}</span><div class="fh-tagrow">${list.map((d) => tag(d.id, d.name)).join('')}</div></div>`).join('');
    box.innerHTML = html;
    box.dataset.bound = '1';
    box.addEventListener('click', (ev) => { const b = ev.target.closest('[data-metric]'); if (!b) return; metric = b.dataset.metric; sortState['t-metric'] = null; draw(); });
  }
  box.querySelectorAll('[data-metric]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.metric === metric)));
}
const srcLine = (ref) => { const opt = ref.endsWith('?'), s = REG.sources.find((x) => x.id === ref.replace('?', '')); if (!s) return '';
  const extra = opt ? 'optional alternative' + (s.kind === 'missing' ? ', not in BigQuery' : '') : s.kind === 'missing' ? 'not in BigQuery' : [s.days > 1 ? `data through ${s.through}` : '', s.partial ? 'partial load' : ''].filter(Boolean).join(', ');
  return `<span class="fh-srcline">${dot(opt ? 'none' : s.status)}${esc(s.system)} · ${esc(s.name)}${extra ? ` <small>(${esc(extra)})</small>` : ''}</span>`; };
function defBlock(d, R) {
  return `<h3 class="fh-mname">${esc(d.name)}</h3><dl class="fh-logic"><div><dt>What it shows</dt><dd>${esc(d.what)}</dd></div><div><dt>How we calculate</dt><dd>${esc(d.how)}</dd></div><div><dt>Data source</dt><dd>${d.source}</dd></div><div><dt>Filters</dt><dd>${esc(d.filters)} · period ${longDay(P(R.start))} – ${longDay(P(R.end))}</dd></div></dl>`;
}
const TAB_ID = { 'Executive Scorecard': 'exec', Revenue: 'revenue', Intake: 'intake', Marketing: 'marketing', 'Case Progress': 'cases', 'High Value Cases': 'highvalue', 'Attorney Performance': 'attorneys' };
const RAW_OF = Object.fromEntries(Object.entries(REG_SRC).map(([raw, reg]) => [reg, raw]));
function regBlock(m, R) {
  const p = m.plain, label = m.status === 'green' ? 'Ready to compute' : m.status === 'yellow' ? 'Partial' : 'Source missing';
  const srcs = m.sources.map((ref) => ({ ref, opt: ref.endsWith('?'), s: REG.sources.find((x) => x.id === ref.replace('?', '')) })).filter((x) => x.s);
  const systems = [...new Set(srcs.filter((x) => !x.opt).map((x) => x.s.system))];
  const rows = srcs.map(({ s, opt }) => {
    const raw = RAW_OF[s.id];
    const when = s.kind === 'missing' ? 'Not in BigQuery yet' + (s.owner ? ` · ${s.owner}` : '') : `Last record ${s.through}${s.partial ? ' · partial load' : ''}`;
    return `<div class="fh-trow">${dot(opt ? 'none' : s.status)}<span class="fh-tname"><b>${esc(s.system)}</b> · ${esc(s.name)}${opt ? ' <small>(optional)</small>' : ''}<br><code>${esc(s.table)}</code></span><span class="fh-twhen">${esc(when)}</span>${raw ? `<button class="fh-link" data-goto-raw="${raw}">Open rows →</button>` : '<span></span>'}</div>`;
  }).join('');
  const tab = TAB_ID[m.tab];
  const tech = [['Why this status', m.reason], ['What the firm asked for', m.client], ['Open point', m.open && m.open !== '—' ? m.open : null], ['Calculation (master v4)', m.calc], ['BigQuery tables (master)', m.bq_tables], ['Key fields', m.fields], ['Client decision and API check, 12 Oct', m.decision && m.decision !== 'None' ? m.decision : null], ['Fallback until the source arrives', m.fallback && m.fallback !== 'None' ? m.fallback : null], ['Master status', m.master]].filter(([, v]) => v);
  return `<div class="fh-mhead"><h3 class="fh-mname">#${m.n} · ${esc(m.short)}</h3>${ragPill(m.status, label)}</div>
    <section class="fh-msec"><h4>Sources</h4>
      <div class="fh-syschips">${systems.map((x) => `<span class="fh-sys">${esc(x)}</span>`).join('')}</div>
      <div class="fh-tlist">${rows}</div></section>
    <section class="fh-msec fh-how"><h4>How we calculate</h4>
      <p><b>We take</b> ${esc(p.take)}</p><p><b>We count</b> ${esc(p.read)}</p><p><b>Period</b> ${esc(p.period)}</p></section>
    <section class="fh-msec"><h4>Used in</h4><div class="fh-used">${tab ? `<button class="fh-link fh-usedbtn" data-goto-tab="${tab}">${esc(m.tab)} tab →</button>` : esc(m.tab)}${m.series ? '<span class="fh-usedtxt">Daily series below</span>' : ''}</div></section>
    <details class="fh-all fh-tech"><summary>More details</summary><dl class="fh-logic fh-tech-body">${tech.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></details>`;
}
function drawCalc(R) {
  fillPicker();
  const md = rows('metrics_daily'), dc = rows('daily_calc'), byDay = new Map(dc.map((r) => [r.day, r]));
  const q = document.getElementById('m-search').value.trim();
  const data = md.filter((r) => inR(r.day, R) && (!q || r.day.includes(q))).map((r) => ({ ...r, ...(byDay.get(r.day) || {}) }));
  let cols;
  const defEl = document.getElementById('m-def');
  document.getElementById('m-series').hidden = false; document.getElementById('m-nodata').hidden = true;
  if (metric === 'all') {
    defEl.innerHTML = `<h3 class="fh-mname">All metrics, by day</h3><p class="fh-def" style="margin-bottom:10px">Period ${longDay(P(R.start))} – ${longDay(P(R.end))}. Each column is one metric for that day; ratio columns are that day’s ratio.</p>
      <details class="fh-all"><summary>How each metric is calculated (${DEFS.length})</summary>${DEFS.map((d) => `<div class="fh-defrow"><b>${esc(d.name)}</b> — ${esc(d.how)} <span class="fh-def">Source: ${d.source}. Filters: ${esc(d.filters)}.</span></div>`).join('')}</details>`;
    const base = ['day', 'revenue', 'costs', 'personnel', 'marketing', 'ga', 'fees_collected', 'ad_spend_google', 'ad_spend_meta', 'leads', 'wanted_leads', 'cases_signed', 'demands_sent', 'cases_settled', 'active_cases', 'pipeline_value', 'avg_fee_12m', 'avg_file_days', 'no_activity_30', 'sol_6m', 'contact_overdue', 'open_demands_30'];
    cols = base.map((f) => ({ f, src: 'metrics_daily', label: FIELD_LABEL[f] })).concat(['operating_margin', 'personnel_pct', 'marketing_pct', 'ga_pct', 'cac', 'wanted_signed_pct'].map((f) => ({ f, src: 'daily_calc', label: FIELD_LABEL[f] })));
  } else if (metric.startsWith('m') && REG) {
    const m = REG.metrics.find((x) => 'm' + x.n === metric); defEl.innerHTML = regBlock(m, R);
    const d = m.series ? DEF[m.series] : null;
    document.getElementById('m-series').hidden = !d;
    if (!d) { document.getElementById('m-nodata').hidden = false; document.getElementById('m-nodata').textContent = m.status === 'red' ? 'No daily series yet: a source is missing.' : 'Daily series for this metric is not built in the preview yet.'; return; }
    document.getElementById('m-nodata').hidden = true;
    cols = [{ f: 'day', src: 'metrics_daily', label: 'Day' }].concat(d.inputs.map((f) => ({ f, src: 'metrics_daily', label: FIELD_LABEL[f] })));
    if (d.kind === 'sum') cols.push({ f: d.f, src: 'metrics_daily', label: d.name + ' (day)' }, { f: d.ytd, src: 'daily_calc', label: 'Year to date', unit: d.unit });
    if (d.kind === 'ratio') cols.push({ f: d.calc, src: 'daily_calc', label: d.name + ' (day)', unit: d.unit }, { f: d.ytd, src: 'daily_calc', label: 'Year to date', unit: d.unit });
    if (d.kind === 'last') cols.push({ f: d.f, src: 'metrics_daily', label: d.name });
  } else {
    const d = DEF[metric]; defEl.innerHTML = defBlock(d, R);
    cols = [{ f: 'day', src: 'metrics_daily', label: 'Day' }].concat(d.inputs.map((f) => ({ f, src: 'metrics_daily', label: FIELD_LABEL[f] })));
    if (d.kind === 'sum') cols.push({ f: d.f, src: 'metrics_daily', label: d.name + ' (day)' }, { f: d.ytd, src: 'daily_calc', label: 'Year to date', unit: d.unit });
    if (d.kind === 'ratio') cols.push({ f: d.calc, src: 'daily_calc', label: d.name + ' (day)', unit: d.unit }, { f: d.ytd, src: 'daily_calc', label: 'Year to date', unit: d.unit });
    if (d.kind === 'last') cols.push({ f: d.f, src: 'metrics_daily', label: d.name });
  }
  const t = document.getElementById('t-metric');
  t.querySelector('thead').innerHTML = '<tr>' + cols.map((c) => `<th class="${c.f === 'day' ? '' : 'num'}" data-field="${c.f}"${c.src === 'daily_calc' ? ' data-source="daily_calc"' : ''}>${esc(c.label)}</th>`).join('') + '</tr>';
  t.querySelectorAll('th').forEach((h) => delete h.dataset.bound);
  if (!sortState['t-metric']) sortState['t-metric'] = { f: 'day', dir: 'desc' };
  const n = table('t-metric', data, cols.map((c) => ({ f: c.f, num: c.f !== 'day', fmt: c.f === 'day' ? null : (v) => fmtCell(c.unit || UNIT_OF(c.f), v) })));
  document.getElementById('m-count').textContent = `${n} days`;
}

// ---------- Data → raw tables ----------
function drawRaw(R) {
  const chips = document.getElementById('src-chips');
  chips.innerHTML = SOURCES.map((s) => `<button class="fh-chip" data-src="${s.id}" aria-pressed="${s.id === src}">${srcStatus(s.id) ? dot(srcStatus(s.id)) : ''}${esc(s.system)} · ${esc(s.name)}</button>`).join('');
  const hb = document.getElementById('src-health');
  if (REG && !hb.dataset.done) { hb.dataset.done = '1'; const c = REG.sourceCounts;
    const list = REG.sources.slice().sort((x, y) => RAG_RANK[x.status] - RAG_RANK[y.status] || (y.days || 0) - (x.days || 0));
    hb.innerHTML = `<div class="fh-mhead"><h3>Data sources</h3><span class="fh-raglegend">${ragPill('green', `${c.green} fresh`)}${ragPill('yellow', `${c.yellow} older than a day`)}${ragPill('red', `${c.red} missing`)}</span></div>
      <p class="note">Checked ${esc(REG.asOf)} in BigQuery. Last record = newest date inside the table (the column used is under it); last sync = when the pipeline last wrote the table. Green = last record today or yesterday. Yellow = older than one day. Red = not in BigQuery yet; who provides it is in the last column.</p>
      <div class="fh-health"><div class="fh-hrow fh-hhead"><span>Status</span><span>Source</span><span>Last record</span><span>Last sync</span><span>Needed for</span><span>Owner</span></div>${list.map((s) => `<div class="fh-hrow">
        <span>${ragPill(s.status)}</span>
        <span><b>${esc(s.system)}</b> · ${esc(s.name)}<br><code>${esc(s.table)}</code><br><small>${esc(s.note)}</small></span>
        <span class="${s.through ? '' : 'fh-dash'}">${s.through ? `${esc(s.through)}<br><small>${s.days > 1 ? `${s.days} days ago · ` : s.days === 1 ? 'yesterday · ' : 'today · '}${esc(s.basis)}</small>${s.partial ? `<br><small class="fh-partial">Partial: ${esc(s.partial)}</small>` : ''}` : '—'}</span>
        <span class="${s.synced ? '' : 'fh-dash'}">${esc(s.synced || '—')}</span>
        <span class="fh-needed">${s.needed.length ? s.needed.map(([n, name, opt]) => `<span class="fh-need${opt ? ' alt' : ''}">#${n} ${esc(name)}${opt ? ' (alt.)' : ''}</span>`).join('') : '—'}</span>
        <span>${esc(s.owner || (s.kind === 'live' ? 'live' : ''))}</span></div>`).join('')}</div>`;
  }
  const s = SOURCES.find((x) => x.id === src), d = dash.data(s.id);
  document.getElementById('src-def').innerHTML = `<h3 class="fh-mname">${esc(s.system)} · ${esc(s.name)}</h3><dl class="fh-logic">
    <div><dt>BigQuery table</dt><dd><code>${esc(s.table)}</code><br><span class="fh-badge ${s.live ? 'live' : ''}">${s.live ? `Live · synced ${esc(s.synced)} · ${int(s.total)} rows in source` : 'Sample data'}</span></dd></div><div><dt>What it holds</dt><dd>${esc(s.note)}</dd></div>
    <div><dt>Filters</dt><dd>Date column inside ${longDay(P(R.start))} – ${longDay(P(R.end))}${s.status ? ' · ' + esc(s.statusLabel) : ''} · text search</dd></div></dl>`;
  const dc = document.getElementById('r-datecol');
  if (dc.dataset.src !== s.id) { dc.dataset.src = s.id; dc.replaceChildren(...s.dates.map((x) => new Option(x, x)), new Option('No date filter', '')); rawState.datecol = s.dateDefault ?? s.dates[0]; rawState.status = ''; sortState['t-raw'] = null; }
  dc.value = rawState.datecol || '';
  const t = document.getElementById('t-raw'); t.dataset.source = s.id; t.dataset.rowKey = s.key;
  if (d.status !== 'ok') { t.querySelector('thead').innerHTML = ''; t.querySelector('tbody').innerHTML = `<tr><td>${d.status === 'error' ? 'Failed to load' : 'Loading…'}</td></tr>`; return; }
  const all = d.data, columns = (d.columns && d.columns.length ? d.columns : Object.keys(all[0] || {}));
  const st = document.getElementById('r-status'), lbl = document.getElementById('r-status-lbl');
  lbl.textContent = s.statusLabel;
  const vals = [...new Set(all.map((r) => r[s.status]).filter((v) => v != null))].sort();
  st.replaceChildren(new Option('All', ''), ...vals.map((v) => new Option(v, v))); st.value = rawState.status;
  const q = rawState.q.toLowerCase();
  const list = all.filter((r) => (!rawState.datecol || (r[rawState.datecol] && inR(String(r[rawState.datecol]).slice(0, 10), R)))
    && (!rawState.status || r[s.status] === rawState.status) && (!q || Object.values(r).join(' ').toLowerCase().includes(q)));
  const numeric = new Set(columns.filter((c) => all.some((r) => typeof r[c] === 'number')));
  t.querySelector('thead').innerHTML = '<tr>' + columns.map((c) => `<th class="${numeric.has(c) ? 'num' : ''}" data-field="${esc(c)}">${esc(c)}</th>`).join('') + '</tr>';
  const keyCols = s.key.split(',');
  const cols = columns.map((c) => ({ f: c, num: numeric.has(c), fmt: numeric.has(c) && !keyCols.includes(c) && !/_id$/.test(c) ? d3.format(',.2~f') : null }));
  const n = table('t-raw', list, cols, null, 500);
  document.getElementById('r-count').textContent = n > 500 ? `Showing 500 of ${int(n)} rows` : `${int(n)} of ${int(all.length)} rows`;
}

// ---------- navigation ----------
function setView(v) { view = v; document.getElementById('dashboard').hidden = v !== 'dashboard'; document.getElementById('data').hidden = v !== 'data';
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v))); }
function showTab(id) { current = id; setView('dashboard'); document.querySelectorAll('.fh-sec[id]').forEach((s) => { if (s.parentElement.id === 'dashboard') s.hidden = s.id !== id; });
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id))); dash.setLink(id); draw(); }
function showData(id) { dtab = id; setView('data'); document.getElementById('calc').hidden = id !== 'calc'; document.getElementById('raw').hidden = id !== 'raw';
  document.querySelectorAll('[data-dtab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.dtab === id))); dash.setLink(id); draw(); }
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => (b.dataset.view === 'data' ? showData(dtab) : showTab(current))));
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.querySelectorAll('[data-dtab]').forEach((b) => b.addEventListener('click', () => showData(b.dataset.dtab)));
document.getElementById('src-chips').addEventListener('click', (ev) => { const b = ev.target.closest('[data-src]'); if (b) { src = b.dataset.src; rawState.q = ''; document.getElementById('r-search').value = ''; draw(); } });
document.getElementById('r-datecol').addEventListener('change', (ev) => { rawState.datecol = ev.target.value || null; draw(); });
document.getElementById('r-status').addEventListener('change', (ev) => { rawState.status = ev.target.value; draw(); });
document.getElementById('r-search').addEventListener('input', (ev) => { rawState.q = ev.target.value.trim(); draw(); });
document.getElementById('m-search').addEventListener('input', draw);
document.getElementById('m-def').addEventListener('click', (ev) => { const r = ev.target.closest('[data-goto-raw]'), t = ev.target.closest('[data-goto-tab]');
  if (r) { src = r.dataset.gotoRaw; rawState.q = ''; document.getElementById('r-search').value = ''; showData('raw'); scrollTo(0, 0); }
  if (t) { showTab(t.dataset.gotoTab); scrollTo(0, 0); } });
document.getElementById('case-aging').addEventListener('click', (ev) => { const t = ev.target.closest('.fh-tile'); if (!t) return; const st = t.dataset.stage; if (pickedStage === st) pickedStage = null; else { pickedStage = st; pickedThr = Number(t.dataset.thr); } draw(); });
document.getElementById('case-aging').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.target.click(); } });
document.getElementById('dd-search').addEventListener('input', draw);
// date filter
document.getElementById('presets').addEventListener('click', (ev) => { const b = ev.target.closest('[data-preset]'); if (!b) return; const p = b.dataset.preset;
  if (p === 'custom') { const R = range(); dash.setParams({ preset: 'custom', start: R.start, end: R.end }); } else dash.setParams({ preset: p, start: null, end: null }); });
const fS = document.getElementById('f-start'), fE = document.getElementById('f-end');
[fS, fE].forEach((inp) => {
  inp.addEventListener('change', () => { if (!inp.value || !inp.validity.valid) return; const R = range(); dash.setParams({ preset: 'custom', start: inp === fS ? inp.value : R.start, end: inp === fE ? inp.value : R.end }); });
  inp.addEventListener('blur', () => draw());
});

function draw() {
  const root = document.getElementById('fh');
  dash.colors.slice(0, 4).forEach((c, i) => root.style.setProperty(`--fh-c${i + 1}`, c));
  const R = range();
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.preset === R.preset)));
  if (document.activeElement !== fS) fS.value = R.start; if (document.activeElement !== fE) fE.value = R.end;
  document.getElementById('range-label').textContent = `${longDay(P(R.start))} – ${longDay(P(R.end))} · daily`;
  if (view === 'data') { if (dtab === 'calc') drawCalc(R); else drawRaw(R); return; }
  if (current === 'exec') { drawExec(R); return; }
  drawTabs(current);
}
const named = location.hash.slice(1);
if (['calc', 'raw', 'data'].includes(named)) { view = 'data'; if (named !== 'data') dtab = named; }
else if (document.getElementById(named)?.classList.contains('fh-sec')) current = named;
if (view === 'data') showData(dtab); else showTab(current);
if (LIVE) { const pill = document.querySelector('.fh-sample'); if (pill) pill.textContent = 'Sample metrics · live raw data'; }
dash.onData(draw);