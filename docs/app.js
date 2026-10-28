/* Work-from-home map: reads JSON written by R/build_data.Rmd from docs/data/ */
(() => {
  'use strict';

  const DATA = 'data/';
  const DEFAULTS = { level: 'metro', dim: 'all', group: 'all_workers', mode: 'change', geo: '12060', fade: true };
  const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

  // Diverging blue (more WFH) <-> red (less WFH), gray midpoint; sequential blue for levels
  const RAMP = {
    light: { neg: ['#8a2020', '#b8302f', '#e34948', '#ef9c97', '#f7d4d2'], mid: '#f0efec',
             pos: ['#cde2fb', '#86b6ef', '#2a78d6', '#1c5cab', '#0d366b'],
             seq: ['#cde2fb', '#86b6ef', '#3987e5', '#256abf', '#184f95', '#0d366b'] },
    dark:  { neg: ['#f3a19c', '#e66767', '#c43c3b', '#8f2a29', '#552020'], mid: '#383835',
             pos: ['#1d3a63', '#184f95', '#2a78d6', '#6da7ec', '#b7d3f6'],
             seq: ['#1d3a63', '#184f95', '#256abf', '#3987e5', '#86b6ef', '#cde2fb'] }
  };

  const $ = (id) => document.getElementById(id);
  const fmt1 = d3.format('.1f');
  const fmtInt = d3.format(',');
  const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt1(Math.abs(v));

  let M;                        // manifest
  const S = {};                 // UI state
  const cache = new Map();
  let map, layer, stateLines, legendCtl, geoIdx = new Map(), curLevel = null;

  const getJSON = (p) => {
    if (!cache.has(p)) cache.set(p, fetch(DATA + p).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    return cache.get(p);
  };

  // ---------------------------------------------------------------- state
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    Object.assign(S, DEFAULTS, { y0: M.baseline_year, y1: M.latest_year });
    for (const k of ['level', 'dim', 'group', 'mode', 'geo']) if (h.get(k)) S[k] = h.get(k);
    for (const k of ['y0', 'y1']) if (h.get(k)) S[k] = +h.get(k);
    if (h.get('fade')) S.fade = h.get('fade') !== '0';
    validate();
  }
  function writeHash() {
    const h = new URLSearchParams({ level: S.level, dim: S.dim, group: S.group, mode: S.mode,
      y0: S.y0, y1: S.y1, geo: S.geo || '', fade: S.fade ? 1 : 0 });
    history.replaceState(null, '', '#' + h.toString());
  }
  function validate() {
    if (!M.levels.some((l) => l.id === S.level) || S.level === 'us') S.level = DEFAULTS.level;
    const dim = M.dims.find((d) => d.id === S.dim) || M.dims[0];
    S.dim = dim.id;
    if (!dim.groups.some((g) => g.key === S.group)) S.group = dim.groups[0].key;
    if (!M.years.includes(S.y0)) S.y0 = M.years.includes(M.baseline_year) ? M.baseline_year : M.years[0];
    if (!M.years.includes(S.y1)) S.y1 = M.latest_year;
    if (S.mode === 'change' && S.y0 >= S.y1) [S.y0, S.y1] = [Math.min(S.y0, S.y1), Math.max(S.y0, S.y1)];
    if (S.y0 === S.y1 && S.mode === 'change') S.y0 = M.years[0];
  }

  // ---------------------------------------------------------------- data access
  const groupLabel = (dim, key) => (M.dims.find((d) => d.id === dim).groups.find((g) => g.key === key) || {}).label || key;
  const dimOf = (id) => M.dims.find((d) => d.id === id);

  function cell(file, geo, gkey, year) {
    const d = file && file.data[geo];
    if (!d) return null;
    const gi = file.groups.indexOf(gkey), yi = file.years.indexOf(year);
    if (gi < 0 || yi < 0 || d.s[gi][yi] == null) return null;
    return { s: d.s[gi][yi], m: d.m[gi][yi], w: d.w[gi][yi] };
  }
  // Value shown on the map / in the panel for the current mode
  function measure(file, geo, gkey) {
    const a = cell(file, geo, gkey, S.y0), b = cell(file, geo, gkey, S.y1);
    if (S.mode === 'level') return b ? { v: b.s, moe: b.m, sig: true, a, b } : null;
    if (!a || !b) return null;
    const moe = a.m == null || b.m == null ? null : Math.sqrt(a.m ** 2 + b.m ** 2);
    const v = b.s - a.s;
    return { v, moe, sig: moe != null && Math.abs(v) > moe, a, b };
  }
  const series = (file, geo, gkey) => M.years.map((y) => ({ y, ...(cell(file, geo, gkey, y) || { s: null, m: null }) }));

  // ---------------------------------------------------------------- color
  function colorScale(values) {
    const R = dark() ? RAMP.dark : RAMP.light;
    if (S.mode === 'level') {
      const hi = Math.max(1, Math.ceil(d3.quantileSorted(values.slice().sort(d3.ascending), 0.98) || 1));
      const sc = d3.scaleSequential([0, hi], d3.interpolateRgbBasis(R.seq)).clamp(true);
      sc.ticks3 = [0, hi / 2, hi];
      return sc;
    }
    // Arms follow the data (most changes since 2019 are increases); gray stays at zero
    const sorted = values.slice().sort(d3.ascending);
    const lo = Math.min(-1, Math.floor(d3.quantileSorted(sorted, 0.02)));
    const hi = Math.max(1, Math.ceil(d3.quantileSorted(sorted, 0.98)));
    const sc = d3.scaleDiverging([lo, 0, hi], d3.interpolateRgbBasis([...R.neg, R.mid, ...R.pos])).clamp(true);
    sc.ticks3 = [lo, 0, hi];
    return sc;
  }

  // ---------------------------------------------------------------- controls
  function fillControls() {
    const opt = (sel, items, val) => {
      sel.innerHTML = items.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      sel.value = String(val);
    };
    opt($('level'), M.levels.filter((l) => l.id !== 'us').map((l) => [l.id, l.label]), S.level);
    opt($('dim'), M.dims.map((d) => [d.id, d.label]), S.dim);
    opt($('group'), dimOf(S.dim).groups.map((g) => [g.key, g.label]), S.group);
    $('group').disabled = S.dim === 'all';
    opt($('mode'), [['change', 'Change (pp)'], ['level', 'Share in year']], S.mode);
    const yrs = M.years.map((y) => [y, y]);
    opt($('y0'), yrs, S.y0);
    opt($('y1'), yrs, S.y1);
    $('y0wrap').style.display = S.mode === 'change' ? '' : 'none';
    $('y1label').textContent = S.mode === 'change' ? 'To' : 'Year';
    $('fade').checked = S.fade;
    $('fade').parentElement.style.display = S.mode === 'change' ? '' : 'none';
  }
  function bindControls() {
    const on = (id, fn) => $(id).addEventListener('change', (e) => { fn(e.target); validate(); fillControls(); update(); });
    on('level', (t) => { S.level = t.value; S.geo = null; });
    on('dim', (t) => { S.dim = t.value; S.group = dimOf(S.dim).groups[0].key; });
    on('group', (t) => { S.group = t.value; });
    on('mode', (t) => { S.mode = t.value; });
    on('y0', (t) => { S.y0 = +t.value; });
    on('y1', (t) => { S.y1 = +t.value; });
    on('fade', (t) => { S.fade = t.checked; });
    $('search').addEventListener('change', (e) => {
      const hit = [...geoIdx.values()].find((g) => g.name.toLowerCase() === e.target.value.toLowerCase());
      if (!hit) return;
      S.geo = hit.id;
      e.target.value = '';
      update().then(() => zoomTo(hit.id));
    });
  }

  // ---------------------------------------------------------------- map
  function initMap() {
    map = L.map('map', { zoomSnap: 0.25, minZoom: 2, worldCopyJump: true }).setView([38.5, -96], 4);
    const theme = dark() ? 'dark' : 'light';
    const attr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/${theme}_nolabels/{z}/{x}/{y}{r}.png`, { attribution: attr, subdomains: 'abcd', maxZoom: 12 }).addTo(map);
    map.createPane('labels');
    map.getPane('labels').style.zIndex = 450;
    map.getPane('labels').style.pointerEvents = 'none';
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/${theme}_only_labels/{z}/{x}/{y}{r}.png`, { pane: 'labels', subdomains: 'abcd', maxZoom: 12 }).addTo(map);
    legendCtl = L.control({ position: 'bottomleft' });
    legendCtl.onAdd = () => L.DomUtil.create('div', 'map-legend');
    legendCtl.addTo(map);
  }

  async function buildLayer() {
    if (layer) layer.remove();
    if (stateLines) { stateLines.remove(); stateLines = null; }
    const idx = (await getJSON(`geo/${S.level}_index.json`)) || [];
    geoIdx = new Map(idx.map((g) => [g.id, g]));
    $('geolist').innerHTML = idx.map((g) => `<option value="${g.name.replace(/"/g, '&quot;')}">`).join('');

    if (S.level === 'place') {
      layer = L.layerGroup(idx.filter((g) => g.lat != null).map((g) => {
        const mk = L.circleMarker([g.lat, g.lon], { radius: 5, weight: 1 });
        mk.feature = { properties: { GEOID: g.id } };
        return mk;
      }));
    } else {
      const gj = await getJSON(`geo/${S.level}.geojson`);
      layer = L.geoJSON(gj || [], { filter: (f) => geoIdx.has(f.properties.GEOID) });
    }
    layer.eachLayer((l) => {
      const id = l.feature.properties.GEOID;
      l.on('mousemove', (e) => showTip(e.originalEvent, mapTip(id)));
      l.on('mouseout', hideTip);
      l.on('click', () => { S.geo = id; update(); });
    });
    layer.addTo(map);
    if (S.level !== 'state') {
      const st = await getJSON('geo/state.geojson');
      if (st) stateLines = L.geoJSON(st, { interactive: false, style: { color: getCSS('--axis'), weight: 0.8, fill: false } }).addTo(map);
    }
    curLevel = S.level;
  }

  let file, allFile, scale;
  function styleLayer() {
    const vals = [];
    for (const id of geoIdx.keys()) { const r = measure(file, id, S.group); if (r) vals.push(r.v); }
    scale = colorScale(vals.length ? vals : [0]);
    const maxW = d3.max([...geoIdx.keys()], (id) => (cell(file, id, S.group, S.y1) || {}).w) || 1;

    layer.eachLayer((l) => {
      const id = l.feature.properties.GEOID;
      const r = measure(file, id, S.group);
      const sel = id === S.geo;
      const faded = r && S.mode === 'change' && S.fade && !r.sig;
      const style = {
        color: sel ? getCSS('--ink') : getCSS('--surface'),
        weight: sel ? 2.5 : (S.level === 'place' ? 1 : 0.6),
        fillColor: r ? scale(r.v) : getCSS('--missing'),
        fillOpacity: r ? (faded ? 0.28 : 0.88) : 0.5,
        dashArray: r ? null : '2 2'
      };
      if (S.level === 'place') {
        const w = (cell(file, id, S.group, S.y1) || {}).w || 0;
        l.setRadius(2.5 + 10 * Math.sqrt(w / maxW));
      }
      l.setStyle(style);
    });
    // Smaller circles on top of larger ones; selected region on top of all
    if (S.level === 'place') layer.getLayers().sort((a, b) => b.getRadius() - a.getRadius()).forEach((l) => l.bringToFront());
    layer.eachLayer((l) => { if (l.feature.properties.GEOID === S.geo && l.bringToFront) l.bringToFront(); });
    drawLegend();
  }
  const getCSS = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function drawLegend() {
    const el = legendCtl.getContainer();
    const [lo, mid, hi] = scale.ticks3;
    const stops = d3.range(0, 1.0001, 0.1).map((t) => scale(lo + t * (hi - lo))).join(',');
    const unit = S.mode === 'change' ? ' pp' : '%';
    const tick = (v) => (S.mode === 'change' ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) : v) + unit;
    const g = groupLabel(S.dim, S.group);
    el.innerHTML = `
      <div class="ttl">${S.mode === 'change' ? `Change in WFH share, ${S.y0}→${S.y1}` : `WFH share, ${S.y1}`}</div>
      <div class="muted" style="color:var(--ink-2);margin-bottom:4px">${g}</div>
      <div class="bar" style="background:linear-gradient(to right,${stops})"></div>
      <div class="ticks" style="position:relative;height:16px"><span style="position:absolute;left:0">${tick(lo)}</span>${mid > lo + (hi - lo) * 0.15 && mid < hi - (hi - lo) * 0.15 ? `<span style="position:absolute;left:${(100 * (mid - lo)) / (hi - lo)}%;transform:translateX(-50%)">${tick(mid)}</span>` : ''}<span style="position:absolute;right:0">${tick(hi)}${S.mode === 'level' ? '+' : ''}</span></div>
      <div class="extra">
        ${S.mode === 'change' && S.fade ? `<span><span class="swatch" style="background:${scale(hi * 0.8)};opacity:.3"></span>Not significant</span>` : ''}
        <span><span class="swatch" style="background:var(--missing)"></span>No estimate</span>
      </div>
      ${S.level === 'place' ? '<div class="note" style="margin-top:4px">Circle size: workers in group</div>' : ''}`;
  }

  function zoomTo(id) {
    layer.eachLayer((l) => {
      if (l.feature.properties.GEOID !== id) return;
      if (l.getBounds) map.fitBounds(l.getBounds(), { maxZoom: 7, padding: [30, 30] });
      else map.setView(l.getLatLng(), Math.max(map.getZoom(), 7));
    });
  }

  function mapTip(id) {
    const g = geoIdx.get(id) || { name: id };
    const r = measure(file, id, S.group);
    const gl = groupLabel(S.dim, S.group);
    if (!r) return `<b>${g.name}</b><br><span class="muted">${gl}: no estimate</span>`;
    const w = r.b && r.b.w != null ? `${fmtInt(r.b.w)} workers in ${S.y1}` : '';
    if (S.mode === 'level') {
      return `<b>${g.name}</b><br>${gl}<br>${fmt1(r.v)}% worked from home in ${S.y1} (±${fmt1(r.moe ?? NaN)})<br><span class="muted">${w}</span>`;
    }
    return `<b>${g.name}</b><br>${gl}<br>${fmt1(r.a.s)}% → ${fmt1(r.b.s)}% · <b>${signed(r.v)} pp</b> ${r.moe != null ? `(±${fmt1(r.moe)})` : ''}
      <br><span class="muted">${r.sig ? 'Significant at 90%' : 'Not significant at 90%'} · ${w}</span>`;
  }

  // ---------------------------------------------------------------- tooltip
  const tip = $('tip');
  function showTip(ev, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14, r = tip.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------------------------------------------------------------- panel
  async function drawPanel() {
    const P = $('panel');
    const g = S.geo && geoIdx.get(S.geo);
    if (!g) {
      P.innerHTML = `<p class="hint">Click a region on the map (or use Find) to see its trend and the change for every group.</p>`;
      return;
    }
    const usFile = await getJSON(`wfh_us_${S.dim}.json`);
    const usKey = usFile ? Object.keys(usFile.data)[0] : null;
    const gl = groupLabel(S.dim, S.group);
    const r = measure(file, S.geo, S.group);
    const lvlLabel = { state: 'State', metro: 'Metro area', place: 'City / place' }[S.level];

    let hero = `<div class="hint">No estimate for this group here (sample too small or area below 65k in some years).</div>`;
    if (r && S.mode === 'change') {
      hero = `<div class="hero"><span class="big">${signed(r.v)} pp</span>
        <span class="detail">${fmt1(r.a.s)}% in ${S.y0} → ${fmt1(r.b.s)}% in ${S.y1}</span></div>
        <div class="sig ${r.sig ? '' : 'ns'}">${r.moe != null ? `MOE ±${fmt1(r.moe)} pp; ` : 'MOE unavailable; '}${r.sig ? 'significant at 90%' : 'not significant at 90%'}</div>`;
    } else if (r) {
      hero = `<div class="hero"><span class="big">${fmt1(r.v)}%</span><span class="detail">worked from home in ${S.y1} (±${fmt1(r.moe ?? NaN)})</span></div><div class="sig"></div>`;
    }

    P.innerHTML = `
      <div class="p-kicker">${lvlLabel}</div>
      <div class="p-title">${g.name}</div>
      <div class="p-kicker">${dimOf(S.dim).label}: ${gl}</div>
      ${hero}
      <div class="section"><h3>Share working from home, ${M.years[0]}–${M.latest_year}</h3>
        <div class="legend-row" id="trend-legend"></div><div id="trend"></div>
        <div class="note">No standard 1-year release for 2020; the dotted segment bridges the gap. Shaded band: 90% MOE.</div>
      </div>
      <div class="section" id="db-section"></div>`;

    // Trend: selected group, all workers here, same group nationally
    const lines = [{ name: `${gl}, ${g.name}`, data: series(file, S.geo, S.group), color: 'var(--series-1)', band: true, width: 2.25 }];
    if (S.dim !== 'all') lines.push({ name: `All workers, ${g.name}`, data: series(allFile, S.geo, 'all_workers'), color: 'var(--series-ref)', width: 1.5 });
    if (usKey) lines.push({ name: `${gl}, U.S.`, data: series(usFile, usKey, S.group), color: 'var(--muted)', dash: '4 3', width: 1.5 });
    $('trend-legend').innerHTML = lines.map((l) => `<span class="key"><span class="sw ${l.dash ? 'dash' : ''}" style="border-color:${l.color}"></span>${l.name}</span>`).join('');
    trendChart($('trend'), lines);

    if (S.dim !== 'all') dumbbell($('db-section'), g);
    else $('db-section').innerHTML = `<p class="hint">Choose a characteristic (sex, age, race, earnings, occupation, industry) to compare groups here.</p>`;
  }

  // Line chart with MOE band, gap at missing years, hover crosshair
  function trendChart(el, lines) {
    const W = el.clientWidth || 360, H = 210, m = { t: 8, r: 18, b: 22, l: 34 };
    const years = M.years, x0 = d3.min(years), x1 = d3.max(years);
    const x = d3.scaleLinear([x0, x1], [m.l, W - m.r]);
    const top = d3.max(lines, (l) => d3.max(l.data, (d) => (d.s == null ? null : d.s + (l.band && d.m ? d.m : 0)))) || 10;
    const y = d3.scaleLinear([0, top * 1.08], [H - m.b, m.t]).nice(4);

    const svg = d3.select(el).append('svg').attr('width', W).attr('height', H).attr('role', 'img')
      .attr('aria-label', 'Line chart of work-from-home share by year');
    svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('class', 'gridline')
      .attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6).tickFormat((d) => d + '%')).call((g) => g.select('.domain').remove());
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(d3.range(x0, x1 + 1).filter((v) => (x1 - x0 > 8 ? v % 2 === x1 % 2 : true))).tickFormat(d3.format('d')).tickSizeOuter(0));
    if (!years.includes(2020) && x0 < 2020 && x1 > 2020) {
      svg.append('text').attr('x', x(2020)).attr('y', m.t + 10).attr('text-anchor', 'middle').style('fill', 'var(--muted)').attr('font-size', 10).text('no 2020');
    }

    // contiguous runs of calendar years with data
    const runs = (data) => {
      const out = []; let cur = [];
      data.forEach((d) => {
        if (d.s == null) { if (cur.length) out.push(cur); cur = []; return; }
        if (cur.length && d.y - cur[cur.length - 1].y > 1) { out.push(cur); cur = []; }
        cur.push(d);
      });
      if (cur.length) out.push(cur);
      return out;
    };
    const line = d3.line().x((d) => x(d.y)).y((d) => y(d.s));
    const area = d3.area().x((d) => x(d.y)).y0((d) => y(Math.max(0, d.s - (d.m || 0)))).y1((d) => y(d.s + (d.m || 0)));

    [...lines].reverse().forEach((l) => {
      const rs = runs(l.data);
      if (l.band) rs.forEach((r) => svg.append('path').attr('d', area(r)).style('fill', 'var(--band)'));
      rs.forEach((r, i) => {
        svg.append('path').attr('d', line(r)).attr('fill', 'none').style('stroke', l.color).attr('stroke-width', l.width)
          .attr('stroke-dasharray', l.dash || null).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');
        if (i > 0) {
          const a = rs[i - 1][rs[i - 1].length - 1], b = r[0];
          svg.append('path').attr('d', line([a, b])).attr('fill', 'none').style('stroke', l.color).attr('stroke-width', 1.25).attr('stroke-dasharray', '1 3').attr('opacity', 0.8);
        }
        if (r.length === 1) svg.append('circle').attr('cx', x(r[0].y)).attr('cy', y(r[0].s)).attr('r', 2.5).style('fill', l.color);
      });
    });

    // hover
    const cross = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).style('stroke', 'var(--axis)').attr('visibility', 'hidden');
    const dots = svg.append('g');
    svg.append('rect').attr('x', m.l).attr('y', 0).attr('width', W - m.l - m.r).attr('height', H).attr('fill', 'transparent')
      .on('mousemove', (ev) => {
        const [px] = d3.pointer(ev);
        const yr = years.reduce((a, b) => (Math.abs(x(b) - px) < Math.abs(x(a) - px) ? b : a));
        cross.attr('x1', x(yr)).attr('x2', x(yr)).attr('visibility', 'visible');
        const pts = lines.map((l) => ({ l, d: l.data.find((d) => d.y === yr) })).filter((p) => p.d && p.d.s != null);
        dots.selectAll('circle').data(pts).join('circle').attr('cx', x(yr)).attr('cy', (p) => y(p.d.s)).attr('r', 4)
          .style('fill', (p) => p.l.color).style('stroke', 'var(--surface)').attr('stroke-width', 2);
        showTip(ev, `<b>${yr}</b>` + lines.map((l) => {
          const d = l.data.find((q) => q.y === yr);
          const v = d && d.s != null ? `${fmt1(d.s)}%${d.m != null ? ` <span class="muted">±${fmt1(d.m)}</span>` : ''}` : '<span class="muted">n/a</span>';
          return `<div class="row"><span class="sw ${l.dash ? 'dash' : ''}" style="border-color:${l.color}"></span>${l.name}: ${v}</div>`;
        }).join(''));
      })
      .on('mouseleave', () => { cross.attr('visibility', 'hidden'); dots.selectAll('*').remove(); hideTip(); });
  }

  // Dumbbell: every group's share in y0 (hollow) and y1 (filled), with change label
  function dumbbell(section, g) {
    const dim = dimOf(S.dim);
    const ya = S.mode === 'change' ? S.y0 : M.baseline_year;  // level mode still contrasts with baseline
    const rows = [{ key: 'all_workers', label: 'All workers', f: allFile, ref: true },
      ...dim.groups.map((gr) => ({ key: gr.key, label: gr.label, f: file }))]
      .map((r) => ({ ...r, a: cell(r.f, S.geo, r.key, ya), b: cell(r.f, S.geo, r.key, S.y1) }));
    rows.forEach((r) => {
      r.moe = r.a && r.b && r.a.m != null && r.b.m != null ? Math.sqrt(r.a.m ** 2 + r.b.m ** 2) : null;
      r.d = r.a && r.b ? r.b.s - r.a.s : null;
      r.sig = r.d != null && r.moe != null && Math.abs(r.d) > r.moe;
    });
    section.innerHTML = `<h3>${dim.label}: share working from home, ${ya} → ${S.y1}</h3>
      <div class="legend-row">
        <span class="key"><span class="dot" style="border:2px solid var(--muted);background:var(--surface)"></span>${ya}</span>
        <span class="key"><span class="dot" style="background:var(--series-1)"></span>${S.y1}</span>
        <span class="key" style="color:var(--muted)">Right: change in pp; grey = not significant</span>
      </div><div id="db"></div>
      ${dim.note ? `<div class="note">${dim.note}</div>` : ''}
      <details class="table"><summary>View as table</summary>${dbTable(rows, ya)}</details>`;

    const el = $('db');
    const W = el.clientWidth || 360, rowH = 38, m = { t: 4, r: 64, b: 22, l: 6 };
    const H = m.t + rows.length * rowH + m.b;
    const max = d3.max(rows, (r) => Math.max(r.a ? r.a.s : 0, r.b ? r.b.s : 0)) || 10;
    const x = d3.scaleLinear([0, max * 1.05], [m.l + 6, W - m.r]).nice(4);
    const svg = d3.select(el).append('svg').attr('width', W).attr('height', H).attr('role', 'img')
      .attr('aria-label', 'Dot plot of work-from-home share by group, two years');
    svg.append('g').selectAll('line').data(x.ticks(4)).join('line').attr('class', 'gridline')
      .attr('x1', x).attr('x2', x).attr('y1', m.t).attr('y2', H - m.b);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat((d) => d + '%').tickSizeOuter(0));

    const row = svg.append('g').selectAll('g').data(rows).join('g')
      .attr('class', (r) => `db-row${r.key === S.group ? ' sel' : ''}`)
      .attr('transform', (r, i) => `translate(0,${m.t + i * rowH})`)
      .on('click', (ev, r) => { if (!r.ref) { S.group = r.key; fillControls(); update(); } })
      .on('mousemove', (ev, r) => showTip(ev, `<b>${r.label}</b><br>` + (r.a && r.b
        ? `${fmt1(r.a.s)}% (${ya}) → ${fmt1(r.b.s)}% (${S.y1})<br><b>${signed(r.d)} pp</b>${r.moe != null ? ` ±${fmt1(r.moe)}` : ''} · ${r.sig ? 'significant' : 'not significant'}<br><span class="muted">${r.b.w != null ? fmtInt(r.b.w) + ' workers in ' + S.y1 : ''}</span>`
        : '<span class="muted">No estimate in one of the years</span>')))
      .on('mouseleave', hideTip);
    row.append('rect').attr('class', 'db-bg').attr('x', 0).attr('width', W).attr('height', rowH - 2).attr('rx', 4).attr('fill', 'transparent');
    row.append('text').attr('class', 'db-label').attr('x', m.l + 4).attr('y', 13)
      .text((r) => truncate(r.label, Math.floor((W - m.r) / 6.4))).style('font-style', (r) => (r.ref ? 'italic' : null));
    const yy = 27;
    row.filter((r) => r.a && r.b).append('line').attr('x1', (r) => x(r.a.s)).attr('x2', (r) => x(r.b.s)).attr('y1', yy).attr('y2', yy)
      .style('stroke', 'var(--axis)').attr('stroke-width', 2);
    row.filter((r) => r.a).append('circle').attr('cx', (r) => x(r.a.s)).attr('cy', yy).attr('r', 4.5)
      .style('fill', 'var(--surface)').style('stroke', 'var(--muted)').attr('stroke-width', 2);
    row.filter((r) => r.b).append('circle').attr('cx', (r) => x(r.b.s)).attr('cy', yy).attr('r', 5)
      .style('fill', (r) => (r.ref ? 'var(--series-ref)' : 'var(--series-1)')).style('stroke', 'var(--surface)').attr('stroke-width', 1.5);
    row.append('text').attr('class', (r) => `db-delta${r.sig ? '' : ' ns'}`).attr('x', W - 4).attr('y', yy + 4).attr('text-anchor', 'end')
      .text((r) => (r.d == null ? 'n/a' : signed(r.d)));
  }
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  function dbTable(rows, ya) {
    const c = (v) => (v == null ? '' : fmt1(v));
    return `<table><thead><tr><th>Group</th><th>${ya} %</th><th>${S.y1} %</th><th>Change</th><th>MOE</th><th>Workers ${S.y1}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.label}</td><td>${c(r.a && r.a.s)}</td><td>${c(r.b && r.b.s)}</td><td>${r.d == null ? '' : signed(r.d)}${r.d != null && !r.sig ? '*' : ''}</td><td>${r.moe == null ? '' : '±' + fmt1(r.moe)}</td><td>${r.b && r.b.w != null ? fmtInt(r.b.w) : ''}</td></tr>`).join('')}</tbody></table><div class="note">* not significant at 90%</div>`;
  }

  // ---------------------------------------------------------------- main loop
  async function update() {
    if (curLevel !== S.level) await buildLayer();
    [file, allFile] = await Promise.all([getJSON(`wfh_${S.level}_${S.dim}.json`), getJSON(`wfh_${S.level}_all.json`)]);
    if (S.geo && !geoIdx.has(S.geo)) S.geo = null;
    styleLayer();
    await drawPanel();
    writeHash();
  }

  async function init() {
    M = await getJSON('manifest.json');
    if (!M) { $('panel').innerHTML = '<div class="error">No data yet. Run R/build_data.Rmd (see README).</div>'; return; }
    readHash();
    $('sub').textContent = `Share of workers 16+ who worked from home · ACS 1-year, ${M.years[0]}–${M.latest_year} (no 2020) · data built ${M.built}`;
    fillControls();
    bindControls();
    initMap();
    await update();
    if (S.geo) zoomTo(S.geo);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
    let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(drawPanel, 200); });
  }
  init();
})();
