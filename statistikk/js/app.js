// Tegner statistikksiden. Dataene kommer fra Firestore via js/load.js, som kaller window.renderStats.
// Alle navn fra dataene settes inn med textContent, aldri innerHTML.
(function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';
  var PERIOD_LABEL = { 7: '7 dager', 30: '30 dager', 90: '90 dager', 365: '12 måneder' };
  var num = new Intl.NumberFormat('nb-NO');
  var compact = new Intl.NumberFormat('nb-NO', { notation: 'compact', maximumFractionDigits: 1 });
  var dayFmt = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' });
  var longFmt = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  var stampFmt = new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium', timeStyle: 'short' });
  var timeFmt = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit' });

  // Two views in one page: the overview (no hash) and one site's details (#<kode>).
  // The hash keeps the back button and bookmarks working without a second HTML file.
  var data = null;
  var state = { site: 'all', period: 30 };
  try {
    var saved = JSON.parse(localStorage.getItem('gc-view') || '{}');
    if (saved.period) state.period = saved.period;
  } catch (e) {}
  function siteFromHash() { return decodeURIComponent(location.hash.slice(1)) || 'all'; }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }
  function color(code) { return 'var(--s-' + code + ')'; }
  function swatch(code) {
    var s = el('span', 'swatch');
    s.style.background = color(code);
    return s;
  }
  function parseDay(d) { return new Date(d + 'T00:00:00'); }

  // The last day in the daily series is always the day the workflow ran, since
  // build_stats.py asks for data up to the hour after the run: that day isn't over.
  // Weekly series never have an unfinished bar, since the running week is left out.
  // A site whose last fetch failed shows the data from the last fetch that worked (stale: true,
  // set by tools/push_stats.py). Its last day is old, so it isn't marked as unfinished.
  function isPending(points, i, stale) { return !stale && state.period <= 90 && i === points.length - 1; }
  function staleNote(s) {
    return el('div', 'tile-stale', 'Tall fra ' + stampFmt.format(new Date(s.fetched_at)) +
      '. Siste henting feilet (' + s.error + ').');
  }

  // A column with a rounded top and a square foot on the baseline.
  function barPath(x, base, w, h, r) {
    r = Math.min(r, w / 2, h);
    var top = base - h;
    return 'M' + x + ' ' + base + 'V' + (top + r) + 'Q' + x + ' ' + top + ' ' + (x + r) + ' ' + top +
      'H' + (x + w - r) + 'Q' + (x + w) + ' ' + top + ' ' + (x + w) + ' ' + (top + r) + 'V' + base + 'Z';
  }

  function selectedSites() {
    return data.sites.filter(function (s) { return state.site === 'all' || s.code === state.site; });
  }
  function okSites() { return selectedSites().filter(function (s) { return s.ok; }); }

  // ---- Filters ---------------------------------------------------------------

  function radio(container, options, current, onPick) {
    container.replaceChildren();
    options.forEach(function (opt) {
      var b = el('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(opt.value === current));
      if (opt.code) b.appendChild(swatch(opt.code));
      b.appendChild(document.createTextNode(opt.label));
      b.addEventListener('click', function () { onPick(opt.value); });
      container.appendChild(b);
    });
  }

  function renderFilters() {
    var periodOpts = data.periods_days.map(function (d) { return { value: d, label: PERIOD_LABEL[d] || d + ' dager' }; });
    radio($('period-filter'), periodOpts, state.period, function (v) { state.period = v; render(); });
  }

  function deltaLine(p) {
    var delta = el('div', 'tile-delta');
    if (p.previous > 0) {
      var change = Math.round((p.visitors - p.previous) / p.previous * 100);
      delta.appendChild(el('span', change > 0 ? 'up' : change < 0 ? 'down' : '',
        (change > 0 ? '▲ +' : change < 0 ? '▼ ' : '') + change + ' %'));
      delta.appendChild(document.createTextNode(' mot forrige ' + (PERIOD_LABEL[state.period] || '')));
    } else {
      delta.textContent = 'Ingen besøk i forrige periode';
    }
    return delta;
  }

  // ---- Overview: one card per site -------------------------------------------

  function sparkline(series) {
    var pts = series.points, W = 300, H = 56, pad = 2;
    var max = Math.max(1, Math.max.apply(null, pts.map(function (p) { return p.n; })));
    var slot = W / Math.max(pts.length, 1);
    var gap = Math.min(2, slot * 0.25), bw = Math.min(24, slot - gap);
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true', 'class': 'spark' });
    pts.forEach(function (p, i) {
      if (!p.n) return;
      var bar = svgEl('path', { d: barPath(i * slot + (slot - bw) / 2, H, bw, p.n / max * (H - pad), 2),
        'class': 'spark-bar' + (isPending(pts, i, series.stale) ? ' pending' : '') });
      bar.style.fill = color(series.code);
      svg.appendChild(bar);
    });

    // The peak value sits on the cap of the tallest column (the latest one on a tie).
    // It is HTML over the SVG, since text inside a non-uniformly stretched SVG distorts.
    var wrap = el('div', 'spark-wrap');
    wrap.appendChild(svg);
    var peak = pts.reduce(function (best, p, i) { return p.n >= pts[best].n ? i : best; }, 0);
    if (pts.length && pts[peak].n > 0) {
      var label = el('span', 'spark-peak', num.format(pts[peak].n));
      var mid = (peak + 0.5) * slot / W * 100, half = bw / 2 / W * 100;
      if (mid < 10) { label.style.left = (mid - half) + '%'; }
      else if (mid > 90) { label.style.left = (mid + half) + '%'; label.style.transform = 'translateX(-100%)'; }
      else { label.style.left = mid + '%'; label.style.transform = 'translateX(-50%)'; }
      wrap.appendChild(label);
    }
    return wrap;
  }

  function renderOverview() {
    var box = $('overview');
    box.replaceChildren();
    data.sites.forEach(function (s) {
      var card = el('a', 'site-card');
      card.href = '#' + encodeURIComponent(s.code);
      var head = el('div', 'tile-label');
      head.appendChild(swatch(s.code));
      head.appendChild(el('span', 'site-name', s.label));
      head.appendChild(el('span', 'site-arrow', '→'));
      card.appendChild(head);
      if (!s.ok) {
        card.appendChild(el('div', 'tile-error', 'Ingen data: ' + s.error));
        box.appendChild(card);
        return;
      }
      var p = s.periods[String(state.period)];
      card.appendChild(el('div', 'site-value', num.format(p.visitors)));
      card.appendChild(el('div', 'site-unit', 'besøkende siste ' + PERIOD_LABEL[state.period]));
      card.appendChild(deltaLine(p));
      card.appendChild(sparkline(seriesFor([s])[0]));
      var sl = searchLine(s.code);
      if (sl) card.appendChild(sl);
      if (s.stale) card.appendChild(staleNote(s));
      card.setAttribute('aria-label', s.label + ': ' + num.format(p.visitors) + ' besøkende siste ' +
        PERIOD_LABEL[state.period] + '. Vis detaljer.');
      box.appendChild(card);
    });
  }

  // ---- Detail: headline tiles for one site -----------------------------------

  function renderKpis() {
    var box = $('kpis');
    box.replaceChildren();
    var s = selectedSites()[0];
    if (!s.ok) {
      var t = el('article', 'tile');
      t.appendChild(el('div', 'tile-error', 'Ingen data: ' + s.error));
      box.appendChild(t);
      return;
    }
    var p = s.periods[String(state.period)];
    var days = s.daily.slice(-state.period);
    var best = days.reduce(function (a, b) { return b.n > a.n ? b : a; }, days[0] || { n: 0, d: null });

    function tile(label, value, extra) {
      var t = el('article', 'tile');
      t.appendChild(el('div', 'tile-label', label));
      t.appendChild(el('div', 'tile-value', value));
      if (extra) t.appendChild(extra);
      box.appendChild(t);
    }
    tile('Besøkende', num.format(p.visitors), deltaLine(p));
    tile('Snitt per dag', num.format(Math.round(p.visitors / Math.max(days.length, 1))));
    tile('Travleste dag', num.format(best.n), best.d ? el('div', 'tile-delta', longFmt.format(parseDay(best.d))) : null);
    if (s.stale) box.firstChild.appendChild(staleNote(s));
  }

  // ---- Trend chart -----------------------------------------------------------

  function trendSeries() { return seriesFor(okSites()); }

  function seriesFor(sites) {
    var weekly = state.period > 90;
    var raw = sites.map(function (s) {
      var byX = {};
      (weekly ? s.weekly.slice(-52) : s.daily.slice(-state.period)).forEach(function (r) {
        byX[weekly ? r.week : r.d] = r.n;
      });
      return { code: s.code, label: s.label, stale: !!s.stale, byX: byX };
    });
    // Align every series on the same x values, so a site with a shorter history reads as 0.
    var seen = {};
    raw.forEach(function (s) { Object.keys(s.byX).forEach(function (x) { seen[x] = true; }); });
    var xs = Object.keys(seen).sort().slice(weekly ? -52 : -state.period);
    return raw.map(function (s) {
      return { code: s.code, label: s.label, stale: s.stale, points: xs.map(function (x) { return { x: x, n: s.byX[x] || 0 }; }) };
    });
  }

  function niceMax(v) {
    if (v <= 4) return 4;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * mag * 4 >= v) return steps[i] * mag * 4;
    }
    return 10 * mag * 4;
  }

  function renderTrend() {
    var weekly = state.period > 90;
    $('trend-title').textContent = weekly ? 'Besøkende per uke' : 'Besøkende per dag';
    $('trend-sub').textContent = weekly ? 'Siste 52 hele uker' : 'Siste ' + PERIOD_LABEL[state.period];

    var series = trendSeries();
    var legend = $('trend-legend');
    legend.replaceChildren();
    if (series.length > 1) {
      series.forEach(function (s) {
        var item = el('span');
        var key = el('i');
        key.style.background = color(s.code);
        item.appendChild(key);
        item.appendChild(document.createTextNode(s.label));
        legend.appendChild(item);
      });
    }

    var box = $('trend-chart');
    box.replaceChildren();
    renderTrendTable(series, weekly);
    if (!series.length || !series[0].points.length) {
      box.appendChild(el('p', 'empty', 'Ingen data for dette utvalget.'));
      return;
    }

    var xs = series[0].points.map(function (p) { return p.x; });
    var W = Math.max(box.clientWidth, 280);
    var narrow = W < 560;
    var m = { top: 12, right: 12, bottom: 28, left: 44 };
    var H = narrow ? 220 : 280;
    var ih = H - m.top - m.bottom;
    var max = niceMax(Math.max.apply(null, series.map(function (s) {
      return Math.max.apply(null, s.points.map(function (p) { return p.n; }));
    })));
    var yAt = function (v) { return m.top + ih - v / max * ih; };
    var iw = W - m.left - m.right;
    // One band per day (or week); the column is centred in it and capped at 24px,
    // with at least a 2px gap to its neighbour once the bands get wide enough.
    var slot = iw / xs.length;
    var gap = Math.min(2, slot * 0.25);
    var bw = Math.min(24, (slot - gap) / series.length);
    var xAt = function (i) { return m.left + (i + 0.5) * slot; };

    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', tabindex: '0',
      'aria-label': 'Søylediagram over besøkende. Bruk piltastene for å flytte mellom søylene; tabellen under har alle tallene.' });

    for (var t = 0; t <= 4; t++) {
      var v = max * t / 4, y = yAt(v);
      svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: y, y2: y, 'class': t === 0 ? 'baseline' : 'gridline' }));
      var lab = svgEl('text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end' });
      lab.textContent = compact.format(v);
      svg.appendChild(lab);
    }

    var ticks = Math.min(xs.length, narrow ? 4 : 6);
    for (var k = 0; k < ticks; k++) {
      var i = Math.round(k * (xs.length - 1) / Math.max(ticks - 1, 1));
      var tx = svgEl('text', { x: xAt(i), y: H - 8, 'text-anchor': k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle' });
      tx.textContent = dayFmt.format(parseDay(xs[i]));
      svg.appendChild(tx);
    }

    // Hover layer: a band behind the columns marks the day under the pointer,
    // one tooltip lists every series.
    var band = svgEl('rect', { y: m.top, width: slot, height: ih, visibility: 'hidden', 'class': 'hover-band' });
    svg.appendChild(band);

    series.forEach(function (s, j) {
      var x0 = (slot - bw * series.length) / 2 + j * bw;
      s.points.forEach(function (p, i) {
        if (!p.n) return;
        var bar = svgEl('path', { d: barPath(m.left + i * slot + x0, m.top + ih, bw, p.n / max * ih, 4),
          'class': 'bar' + (isPending(s.points, i, s.stale) ? ' pending' : '') });
        bar.style.fill = color(s.code);
        svg.appendChild(bar);
      });
    });

    var hit = svgEl('rect', { x: m.left, y: m.top, width: iw, height: ih, 'class': 'hit' });
    svg.appendChild(hit);

    var active = xs.length - 1;
    function show(i, clientX, clientY) {
      active = i;
      band.setAttribute('x', m.left + i * slot);
      band.setAttribute('visibility', 'visible');
      var title = weekly ? 'Uka fra ' + longFmt.format(parseDay(xs[i])) : longFmt.format(parseDay(xs[i]));
      if (isPending(xs, i, series.some(function (s) { return s.stale; }))) title += ' · ikke ferdig, tall fra kl. ' + timeFmt.format(new Date(data.generated_at));
      showTooltip(title, series.map(function (s) {
        return { code: s.code, label: s.label, value: num.format(s.points[i].n) };
      }), clientX, clientY);
    }
    function hide() { band.setAttribute('visibility', 'hidden'); hideTooltip(); }
    function indexAt(evt) {
      var r = svg.getBoundingClientRect();
      var px = (evt.clientX - r.left) * W / r.width;
      return Math.max(0, Math.min(xs.length - 1, Math.floor((px - m.left) / slot)));
    }
    hit.addEventListener('pointermove', function (e) { show(indexAt(e), e.clientX, e.clientY); });
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var i = Math.max(0, Math.min(xs.length - 1, active + (e.key === 'ArrowLeft' ? -1 : 1)));
      var r = svg.getBoundingClientRect();
      show(i, r.left + xAt(i) * r.width / W, r.top + m.top * r.height / H + 20);
    });

    box.appendChild(svg);
  }

  function renderTrendTable(series, weekly) {
    var box = $('trend-table');
    box.replaceChildren();
    if (!series.length) return;
    var table = el('table');
    var head = el('tr');
    head.appendChild(el('th', null, weekly ? 'Uke fra' : 'Dag'));
    series.forEach(function (s) { head.appendChild(el('th', null, s.label)); });
    table.appendChild(head);
    series[0].points.slice().reverse().forEach(function (p, ri) {
      var i = series[0].points.length - 1 - ri;
      var tr = el('tr');
      tr.appendChild(el('td', null, longFmt.format(parseDay(p.x)) + (isPending(series[0].points, i, series[0].stale) ? ' (ikke ferdig)' : '')));
      series.forEach(function (s) { tr.appendChild(el('td', null, num.format(s.points[i].n))); });
      table.appendChild(tr);
    });
    box.appendChild(table);
  }

  // ---- Bar lists -------------------------------------------------------------

  function renderBars(listId, noteId, rowsKey, hiddenKey, one, many) {
    var rows = [], hidden = { rows: 0, n: 0 };
    okSites().forEach(function (s) {
      var p = s.periods[String(state.period)];
      p[rowsKey].forEach(function (r) { rows.push({ name: r.name, n: r.n, code: s.code }); });
      hidden = p[hiddenKey];
    });

    var list = $(listId);
    list.replaceChildren();
    if (!rows.length) list.appendChild(el('li', 'empty', 'Ingenting over terskelen i denne perioden.'));
    var max = rows.length ? rows[0].n : 1;
    rows.forEach(function (r) {
      var li = el('li');
      var label = el('div', 'bar-label');
      var name = el('span', 'bar-name', r.name);
      label.appendChild(name);
      label.appendChild(el('span', 'bar-value', num.format(r.n)));
      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = (r.n / max * 100) + '%';
      fill.style.background = color(r.code);
      track.appendChild(fill);
      li.appendChild(label);
      li.appendChild(track);
      list.appendChild(li);
    });

    $(noteId).textContent = hidden.rows
      ? 'Ytterligere ' + num.format(hidden.rows) + ' ' + (hidden.rows === 1 ? one : many) + ' (til sammen ' + num.format(hidden.n) +
        ' besøkende) vises ikke: færre enn ' + data.min_count + ' besøkende hver, eller utenfor topp 15.'
      : '';
  }

  // ---- Google-søk (Search Console) -------------------------------------------
  //
  // data.search kommer fra tools/searchconsole_stats.py: per domene en daglig serie
  // [dato, klikk, visninger, plassering] og ferdig filtrerte topplister per periode. Perioden
  // regnes bakover fra siste dag Google har data for (to-tre dager bak), ikke fra i dag.

  var pct = new Intl.NumberFormat('nb-NO', { style: 'percent', maximumFractionDigits: 1 });
  var dec1 = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function searchSites() { return (data.search && data.search.sites) || []; }
  function searchFor(site) {
    return searchSites().filter(function (g) {
      return state.site.indexOf('google:') === 0 ? 'google:' + g.domain === state.site : g.code === site;
    })[0];
  }
  function searchHref(g) { return '#' + encodeURIComponent(g.code || 'google:' + g.domain); }
  function addDays(iso, n) {
    var d = parseDay(iso);
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('sv-SE');
  }
  // Summer over [from, to] i den daglige serien; plasseringen vektet med visninger.
  function sumDays(g, from, to) {
    var c = 0, i = 0, pw = 0;
    g.daily.forEach(function (r) {
      if (r[0] < from || r[0] > to) return;
      c += r[1]; i += r[2]; pw += r[3] * r[2];
    });
    return { clicks: c, impressions: i, position: i ? pw / i : null };
  }
  function windowOf(g) {
    var n = state.period;
    return { to: g.last_date, from: addDays(g.last_date, -(n - 1)), prevTo: addDays(g.last_date, -n), prevFrom: addDays(g.last_date, -(2 * n - 1)) };
  }
  function searchSubText(g) {
    return 'Search Console, ' + PERIOD_LABEL[state.period] + ' til og med ' + longFmt.format(parseDay(g.last_date)) +
      '. Google ligger to-tre dager etter.' + (data.search.stale ? ' Siste henting feilet; tallene er fra ' +
      stampFmt.format(new Date(data.search.generated_at)) + '.' : '');
  }
  function change(now, before) {
    if (!before) return null;
    var c = Math.round((now - before) / before * 100);
    var d = el('div', 'tile-delta');
    d.appendChild(el('span', c > 0 ? 'up' : c < 0 ? 'down' : '', (c > 0 ? '▲ +' : c < 0 ? '▼ ' : '') + c + ' %'));
    d.appendChild(document.createTextNode(' mot forrige ' + PERIOD_LABEL[state.period]));
    return d;
  }

  // Oversikten: én rad per domene i Search Console.
  function renderSearchOverview() {
    var box = $('search-overview');
    var gs = searchSites();
    box.hidden = !gs.length;
    if (!gs.length) return;
    $('so-sub').textContent = searchSubText(gs[0]);
    var table = el('table', 'search-table');
    var head = el('tr');
    ['Domene', 'Klikk', 'Visninger', 'Klikkrate', 'Snittplass'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    gs.map(function (g) { var w = windowOf(g); return { g: g, p: sumDays(g, w.from, w.to) }; })
      .sort(function (a, b) { return b.p.clicks - a.p.clicks || b.p.impressions - a.p.impressions; })
      .forEach(function (r) {
        var tr = el('tr');
        var td = el('td');
        var a = el('a', 'link', r.g.label);
        a.href = searchHref(r.g);
        if (r.g.code) td.appendChild(swatch(r.g.code));
        td.appendChild(a);
        tr.appendChild(td);
        tr.appendChild(el('td', null, num.format(r.p.clicks)));
        tr.appendChild(el('td', null, num.format(r.p.impressions)));
        tr.appendChild(el('td', null, r.p.impressions ? pct.format(r.p.clicks / r.p.impressions) : '–'));
        tr.appendChild(el('td', null, r.p.position != null ? dec1.format(r.p.position) : '–'));
        table.appendChild(tr);
      });
    $('so-table').replaceChildren(table);
  }

  // Linja under sparklinen på kortene i oversikten.
  function searchLine(code) {
    var g = searchSites().filter(function (x) { return x.code === code; })[0];
    if (!g) return null;
    var w = windowOf(g), p = sumDays(g, w.from, w.to);
    return el('div', 'site-search', 'Google-søk: ' + num.format(p.clicks) + ' klikk, ' + num.format(p.impressions) + ' visninger');
  }

  function renderSearchDetail(code) {
    var g = searchFor(code);
    $('search-detail').hidden = !g;
    if (!g) return;
    var w = windowOf(g), p = sumDays(g, w.from, w.to), prev = sumDays(g, w.prevFrom, w.prevTo);
    $('search-sub').textContent = searchSubText(g);

    var box = $('search-kpis');
    box.replaceChildren();
    function tile(label, value, extra, help) {
      var t = el('article', 'tile');
      t.appendChild(el('div', 'tile-label', label));
      t.appendChild(el('div', 'tile-value', value));
      if (extra) t.appendChild(extra);
      if (help) t.title = help;
      box.appendChild(t);
    }
    tile('Klikk', num.format(p.clicks), change(p.clicks, prev.clicks), 'Klikk fra Googles søkeresultater til siden');
    tile('Visninger', num.format(p.impressions), change(p.impressions, prev.impressions), 'Hvor ofte en side herfra var med i et søkeresultat');
    tile('Klikkrate', p.impressions ? pct.format(p.clicks / p.impressions) : '–', null, 'Klikk delt på visninger');
    tile('Snittplassering', p.position != null ? dec1.format(p.position) : '–',
      el('div', 'tile-delta', 'Lavere er bedre; 1 er øverst'), 'Gjennomsnittlig plass i søkeresultatene, vektet med visninger');

    renderSearchChart(g, w);
    var lists = g.periods[String(state.period)];
    searchTable('queries', 'queries-hidden', lists ? lists.queries : [], lists ? lists.queries_hidden : null, 'q', 'Søk', 'søk');
    searchTable('spages', 'spages-hidden', lists ? lists.pages : [], lists ? lists.pages_hidden : null, 'path', 'Side', 'sider');
  }

  function searchTable(id, noteId, rows, hidden, key, title, many) {
    var box = $(id);
    if (!rows.length) {
      box.replaceChildren(el('p', 'empty', 'Ingenting over terskelen i denne perioden.'));
    } else {
      var table = el('table', 'search-table');
      var head = el('tr');
      [title, 'Klikk', 'Visn.', 'Plass'].forEach(function (h) { head.appendChild(el('th', null, h)); });
      table.appendChild(head);
      rows.forEach(function (r) {
        var tr = el('tr');
        tr.appendChild(el('td', 'search-name', r[key]));
        tr.appendChild(el('td', null, num.format(r.clicks)));
        tr.appendChild(el('td', null, num.format(r.impressions)));
        tr.appendChild(el('td', null, dec1.format(r.position)));
        table.appendChild(tr);
      });
      box.replaceChildren(table);
    }
    $(noteId).textContent = hidden && hidden.rows
      ? 'Ytterligere ' + num.format(hidden.rows) + ' ' + many + ' (' + num.format(hidden.clicks) + ' klikk, ' +
        num.format(hidden.impressions) + ' visninger) er utenfor topp 50. Søk Google anser som sjeldne, er ikke med i lista i det hele tatt.'
      : '';
  }

  // Klikk per dag (per uke for 12 måneder) som søyler; visningene i tooltipen.
  function renderSearchChart(g, w) {
    var box = $('search-chart');
    box.replaceChildren();
    var byDay = {};
    g.daily.forEach(function (r) { byDay[r[0]] = r; });
    var pts = [];
    var weekly = state.period > 90;
    for (var d = w.from; d <= w.to; d = addDays(d, weekly ? 7 : 1)) {
      var c = 0, im = 0;
      for (var k = 0; k < (weekly ? 7 : 1); k++) {
        var r = byDay[addDays(d, k)];
        if (r && addDays(d, k) <= w.to) { c += r[1]; im += r[2]; }
      }
      pts.push({ x: d, c: c, i: im });
    }
    if (!pts.length) return;
    var W = Math.max(box.clientWidth, 280), H = 180;
    var m = { top: 12, right: 12, bottom: 28, left: 44 }, ih = H - m.top - m.bottom, iw = W - m.left - m.right;
    var max = niceMax(Math.max.apply(null, pts.map(function (p) { return p.c; })));
    var slot = iw / pts.length, bw = Math.min(24, slot - Math.min(2, slot * 0.25));
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img',
      'aria-label': 'Klikk fra Google-søk per ' + (weekly ? 'uke' : 'dag') });
    for (var t = 0; t <= 4; t++) {
      var y = m.top + ih - t / 4 * ih;
      svg.appendChild(svgEl('line', { x1: m.left, x2: m.left + iw, y1: y, y2: y, 'class': t === 0 ? 'baseline' : 'gridline' }));
      var lab = svgEl('text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end' });
      lab.textContent = compact.format(max * t / 4);
      svg.appendChild(lab);
    }
    var ticks = Math.min(pts.length, W < 560 ? 3 : 5);
    for (var j = 0; j < ticks; j++) {
      var i = Math.round(j * (pts.length - 1) / Math.max(ticks - 1, 1));
      var tx = svgEl('text', { x: m.left + (i + 0.5) * slot, y: H - 8, 'text-anchor': j === 0 ? 'start' : j === ticks - 1 ? 'end' : 'middle' });
      tx.textContent = dayFmt.format(parseDay(pts[i].x));
      svg.appendChild(tx);
    }
    var band = svgEl('rect', { y: m.top, width: slot, height: ih, visibility: 'hidden', 'class': 'hover-band' });
    svg.appendChild(band);
    var fill = g.code ? color(g.code) : 'var(--accent)';
    pts.forEach(function (p, i) {
      if (!p.c) return;
      var bar = svgEl('path', { d: barPath(m.left + i * slot + (slot - bw) / 2, m.top + ih, bw, p.c / max * ih, 3), 'class': 'bar' });
      bar.style.fill = fill;
      svg.appendChild(bar);
    });
    var hit = svgEl('rect', { x: m.left, y: m.top, width: iw, height: ih, 'class': 'hit' });
    svg.appendChild(hit);
    hit.addEventListener('pointermove', function (e) {
      var r = svg.getBoundingClientRect();
      var i = Math.max(0, Math.min(pts.length - 1, Math.floor(((e.clientX - r.left) * W / r.width - m.left) / slot)));
      band.setAttribute('x', m.left + i * slot);
      band.setAttribute('visibility', 'visible');
      var p = pts[i];
      showTooltip((weekly ? 'Uka fra ' : '') + longFmt.format(parseDay(p.x)), [
        { code: g.code || 'none', label: 'klikk', value: num.format(p.c) },
        { code: g.code || 'none', label: 'visninger', value: num.format(p.i) },
      ], e.clientX, e.clientY);
    });
    hit.addEventListener('pointerleave', function () { band.setAttribute('visibility', 'hidden'); hideTooltip(); });
    box.appendChild(svg);
  }

  // ---- Tooltip ---------------------------------------------------------------

  function showTooltip(title, rows, x, y) {
    var tip = $('tooltip');
    tip.replaceChildren();
    tip.appendChild(el('div', 'tt-title', title));
    rows.forEach(function (r) {
      var row = el('div', 'tt-row');
      var key = el('i');
      key.style.background = color(r.code);
      row.appendChild(key);
      row.appendChild(el('b', null, r.value));
      row.appendChild(el('span', null, r.label));
      tip.appendChild(row);
    });
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = x + 16 + w > window.innerWidth ? x - 16 - w : x + 16;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, Math.min(y - h / 2, window.innerHeight - h - 8)) + 'px';
  }
  function hideTooltip() { $('tooltip').hidden = true; }

  // ---- Main ------------------------------------------------------------------

  function render() {
    state.site = siteFromHash();
    var site = data.sites.filter(function (s) { return s.code === state.site; })[0];
    // #google:<domene>: et domene som bare finnes i Search Console, ikke i GoatCounter.
    var gOnly = !site && state.site.indexOf('google:') === 0 ? searchFor(null) : null;
    if (!site && !gOnly) state.site = 'all';
    if (data.periods_days.indexOf(state.period) < 0) state.period = data.periods_days[1] || data.periods_days[0];
    try { localStorage.setItem('gc-view', JSON.stringify({ period: state.period })); } catch (e) {}

    var overview = state.site === 'all';
    $('overview').hidden = !overview;
    $('detail').hidden = overview;
    $('back').hidden = overview;
    var label = overview ? 'Alle sider' : site ? site.label : gOnly.label;
    $('page-title').textContent = label;
    document.title = overview ? 'Besøksstatistikk' : label + ' · Besøksstatistikk';
    renderFilters();
    $('search-overview').hidden = true;
    if (overview) {
      renderOverview();
      renderSearchOverview();
      return;
    }
    $('gc-detail').hidden = !site;
    renderSearchDetail(site ? site.code : null);
    if (!site) return;
    renderKpis();
    renderTrend();
    renderBars('pages', 'pages-hidden', 'pages', 'pages_hidden', 'side', 'sider');
    renderBars('refs', 'refs-hidden', 'refs', 'refs_hidden', 'kilde', 'kilder');
  }

  window.addEventListener('hashchange', function () {
    if (!data) return;
    hideTooltip();
    render();
    window.scrollTo(0, 0);
  });

  // Dataene kommer ikke lenger fra en publisert data/stats.json, men fra Firestore etter
  // innlogging (js/load.js). load.js kaller window.renderStats med samme JSON som før.
  var observing = false;
  window.renderStats = function (json) {
    data = json;
    $('notice').hidden = true;
    $('updated').textContent = 'Oppdatert ' + stampFmt.format(new Date(data.generated_at));
    render();
    if (observing) return;
    observing = true;
    var width = $('trend-chart').clientWidth;
    new ResizeObserver(function () {
      var w = $('trend-chart').clientWidth;
      if (w && Math.abs(w - width) > 4) { width = w; renderTrend(); if (!$('search-detail').hidden) renderSearchDetail(state.site); }
    }).observe($('trend-chart'));
  };
})();
