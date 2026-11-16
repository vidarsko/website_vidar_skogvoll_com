// Vekt og fettprosent fra Fitbit Aria, via Google Health API.
//
// Flyt: Vidar er logget inn med Firebase (Google). Knappen «Hent fra vekta» ber Google om en
// kortvarig tilgangsnøkkel med lesetilgang til målinger (Google Identity Services, i nettleseren).
// Nøkkelen brukes til å hente nye veiinger, som lagres i Firestore (samlingen «maalinger»), og
// siden viser alltid det som ligger i Firestore. Ingen nøkkel lagres noe sted; den lever i
// minnet til fanen lukkes.
//
// Historikken 2014-2026 fra Vidars regneark ligger også i «maalinger» (kilde «regneark» og
// «regneark-ifttt»). Har Google en veiing samme dag, vises ikke regnearkets.
//
// Analysene er de fra regnearkets ark 2: trend som lokal lineær regresjon over N målinger før og
// M etter hvert punkt (FORECAST), vektderivert som stigningstallet i samme vindu (g/dag), og
// avvik fra trend per ukedag. Se kalorier_private/AGENTS.md.

import {
  getFirestore, collection, doc, getDocs, writeBatch, query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, configured, mountAuthBar, onUser, signIn, showError } from '/js/auth.js';
import { googleClientId } from '/js/firebase-config.js';

const SCOPE = 'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly';
const API = 'https://health.googleapis.com/v4/users/me/dataTypes';
const FIRST_SYNC_DAYS = 730; // første gang: hent to år bakover

const $ = (id) => document.getElementById(id);
const db = configured ? getFirestore(app) : null;
let currentUser = null;
let rows = []; // { id, type: 'weight'|'bodyFat', t: Date, value }

function say(text, withLogin) {
  const n = $('notice');
  n.textContent = text;
  if (withLogin) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = 'Logg inn med Google';
    b.addEventListener('click', () => signIn().catch(showError));
    n.append(b);
  }
  n.hidden = !text;
}

// ---- Firestore ----

async function loadRows() {
  const snap = await getDocs(query(collection(db, 'maalinger'), orderBy('t')));
  rows = snap.docs.map((d) => {
    const x = d.data();
    return { id: d.id, type: x.type, t: x.t.toDate(), value: x.value, kilde: x.kilde || '' };
  });
}

async function saveRows(newRows) {
  for (let i = 0; i < newRows.length; i += 400) {
    const batch = writeBatch(db);
    for (const r of newRows.slice(i, i + 400)) {
      batch.set(doc(db, 'maalinger', r.id), { type: r.type, t: r.t, value: r.value, kilde: r.kilde });
    }
    await batch.commit();
  }
}

// ---- Google Health API ----

function getToken() {
  return new Promise((resolve, reject) => {
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      reject(new Error('Google-skriptet er ikke lastet ennå. Prøv igjen om et øyeblikk.'));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: SCOPE,
      hint: currentUser && currentUser.email,
      prompt: '',
      callback: (resp) => (resp.error ? reject(new Error(resp.error)) : resolve(resp.access_token)),
      error_callback: (err) => reject(new Error(err.type || 'avbrutt')),
    });
    client.requestAccessToken();
  });
}

// Feltnavnet i filteret er ikke dokumentert for body-fat. `weight` virker; for fett prøves
// `body_fat` (snake_case, som i AIP-160) og så `bodyFat`. Gir begge 400, hentes uten filter og
// sorteres på tid her. Det første navnet som virker, huskes for resten av økta.
const FILTER_NAMES = { weight: ['weight'], bodyFat: ['body_fat', 'bodyFat', null] };
const workingFilter = {};

async function errorText(r) {
  try {
    const j = await r.json();
    return (j.error && j.error.message) || '';
  } catch (e) {
    return '';
  }
}

async function fetchType(token, apiType, field, since) {
  const names = field in workingFilter ? [workingFilter[field]] : FILTER_NAMES[field];
  let lastError = null;
  for (const name of names) {
    try {
      const out = await fetchPages(token, apiType, field, since, name);
      workingFilter[field] = name;
      return out;
    } catch (err) {
      lastError = err;
      if (err.status !== 400) break;
    }
  }
  throw lastError;
}

async function fetchPages(token, apiType, field, since, filterName) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ pageSize: '1000' });
    if (filterName) params.set('filter', `${filterName}.sample_time.physical_time >= "${since.toISOString()}"`);
    if (pageToken) params.set('pageToken', pageToken);
    const r = await fetch(`${API}/${apiType}/dataPoints?${params}`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) {
      const err = new Error(`Google Health svarte ${r.status} for ${apiType}: ${await errorText(r)}`);
      err.status = r.status;
      throw err;
    }
    const json = await r.json();
    for (const p of json.dataPoints || []) {
      const m = p[field];
      if (!m || !m.sampleTime || !m.sampleTime.physicalTime) continue;
      if (!filterName && new Date(m.sampleTime.physicalTime) < since) continue;
      const value = field === 'weight' ? m.weightGrams / 1000 : m.percentage;
      out.push({
        id: p.name.replace(/\//g, '_'),
        type: field,
        t: new Date(m.sampleTime.physicalTime),
        value: Math.round(value * 100) / 100,
        kilde: (p.dataSource && p.dataSource.device && p.dataSource.device.displayName) || '',
      });
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return out;
}

async function sync(everything) {
  const button = $('sync');
  button.disabled = true;
  $('sync-all').disabled = true;
  say(everything ? 'Henter hele historikken fra Google … (kan ta litt tid)' : 'Henter fra Google …');
  try {
    const token = await getToken();
    const google = rows.filter((r) => !String(r.kilde).startsWith('regneark'));
    const last = google.length ? google[google.length - 1].t : null;
    // Litt overlapp, så en veiing som kom sent inn ikke faller mellom to henting.
    const since = everything
      ? new Date('2010-01-01T00:00:00Z')
      : last
        ? new Date(last.getTime() - 3 * 864e5)
        : new Date(Date.now() - FIRST_SYNC_DAYS * 864e5);
    // Hver type for seg: feiler fettprosenten, lagres vekta likevel.
    const fetched = [];
    const problems = [];
    for (const [apiType, field] of [['weight', 'weight'], ['body-fat', 'bodyFat']]) {
      try {
        fetched.push(...(await fetchType(token, apiType, field, since)));
      } catch (err) {
        problems.push(err.message);
      }
    }
    const known = new Set(rows.map((r) => r.id));
    const fresh = fetched.filter((r) => !known.has(r.id));
    if (fresh.length) await saveRows(fresh);
    await loadRows();
    render();
    const done = fresh.length ? `Hentet ${fresh.length} nye målinger.` : 'Ingen nye målinger.';
    say(problems.length ? `${done} Feil: ${problems.join(' · ')}` : done);
  } catch (err) {
    say('Klarte ikke å hente: ' + err.message);
  } finally {
    button.disabled = false;
    $('sync-all').disabled = false;
  }
}


// ---- Analyse (regnearkets ark 2) ----

const DAY = 864e5;
const SETTINGS_KEY = 'vekt-innstillinger';
const PERIODS = [['90', '90 dager'], ['365', '1 år'], ['730', '2 år'], ['1825', '5 år'], ['all', 'Alt']];
const WEEKDAYS = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];
let settings = { period: '365', before: 30, after: 30 };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) {}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

const dayKey = (t) => t.toLocaleDateString('sv-SE'); // YYYY-MM-DD i lokal tid
const isSheet = (r) => String(r.kilde).startsWith('regneark');

// Vekt der regnearkets veiinger faller bort de dagene Google har en.
function cleanWeights() {
  const all = rows.filter((r) => r.type === 'weight');
  const googleDays = new Set(all.filter((r) => !isSheet(r)).map((r) => dayKey(r.t)));
  return all.filter((r) => !(isSheet(r) && googleDays.has(dayKey(r.t)))).sort((a, b) => a.t - b.t);
}

// Lokal lineær regresjon: for punkt i, tilpass en rett linje til målingene i-before … i+after.
// trend = linjens verdi i punktet (regnearkets FORECAST), deriv = stigningstallet i g/dag (SLOPE*1000).
function trendOf(points, before, after) {
  const xs = points.map((p) => p.t / DAY);
  return points.map((p, i) => {
    const lo = Math.max(0, i - before), hi = Math.min(points.length - 1, i + after);
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = lo; j <= hi; j++) {
      const x = xs[j] - xs[i], y = points[j].value;
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const den = n * sxx - sx * sx;
    const b = den ? (n * sxy - sx * sy) / den : 0;
    const a = (sy - b * sx) / n; // x = 0 i punktet selv
    return { t: p.t, value: p.value, trend: a, deriv: b * 1000 };
  });
}

const fmt1 = (v) => v.toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt0 = (v) => Math.round(v).toLocaleString('nb-NO');
const dayFmt = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit' });

function hasTime(r) { return !(isSheet(r) && r.t.getHours() === 0 && r.t.getMinutes() === 0); }
function when(r) { return dayFmt.format(r.t) + (hasTime(r) ? ', ' + timeFmt.format(r.t) : ''); }

function render() {
  $('content').hidden = false;
  const weights = cleanWeights();
  const fats = rows.filter((r) => r.type === 'bodyFat').sort((a, b) => a.t - b.t);
  if (!weights.length) {
    say('Ingen veiinger lagret ennå. Trykk «Hent fra vekta».');
    return;
  }
  renderControls();

  const all = trendOf(weights, settings.before, settings.after);
  const from = settings.period === 'all' ? weights[0].t : new Date(Date.now() - Number(settings.period) * DAY);
  const shown = all.filter((p) => p.t >= from);
  const shownFat = fats.filter((p) => p.t >= from);
  const last = all[all.length - 1];

  $('kpi-weight').textContent = fmt1(weights[weights.length - 1].value) + ' kg';
  $('kpi-weight-sub').textContent = when(weights[weights.length - 1]);
  $('kpi-trend').textContent = fmt1(last.trend) + ' kg';
  $('kpi-trend-sub').textContent = `Trend med ${settings.before} målinger før og ${settings.after} etter`;
  $('kpi-rate').textContent = (last.deriv > 0 ? '+' : last.deriv < 0 ? '−' : '') + fmt0(Math.abs(last.deriv)) + ' g/dag';
  $('kpi-rate-sub').textContent = `${last.deriv > 0 ? '+' : last.deriv < 0 ? '−' : ''}${(Math.abs(last.deriv) * 7 / 1000).toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg per uke`;
  if (fats.length) {
    $('kpi-fat').textContent = fmt1(fats[fats.length - 1].value) + ' %';
    $('kpi-fat-sub').textContent = when(fats[fats.length - 1]);
  }

  const range = [shown.length ? shown[0].t : from, new Date()];
  lineChart($('chart-weight'), range, [
    { pts: shown.map((p) => ({ t: p.t, v: p.value })), cls: 'weight-dot', dots: true },
    { pts: shown.map((p) => ({ t: p.t, v: p.trend })), cls: 'weight-trend' },
  ], { unit: 'kg' });
  lineChart($('chart-deriv'), range, [
    { pts: shown.map((p) => ({ t: p.t, v: p.deriv })), cls: 'deriv-line' },
  ], { unit: 'g/dag', zero: true });
  weekdayChart($('chart-weekday'), shown);
  if (shownFat.length) {
    const fatTrend = trendOf(shownFat, Math.min(settings.before, 15), Math.min(settings.after, 15));
    lineChart($('chart-fat'), range, [
      { pts: shownFat.map((p) => ({ t: p.t, v: p.value })), cls: 'fat-dot', dots: true },
      { pts: fatTrend.map((p) => ({ t: p.t, v: p.trend })), cls: 'fat-trend' },
    ], { unit: '%' });
    $('fat-panel').hidden = false;
  } else {
    $('fat-panel').hidden = true;
  }
  $('period-sub').textContent = `${shown.length} veiinger i perioden`;
  renderList(weights, fats);
}

function renderControls() {
  const seg = $('period');
  if (!seg.childElementCount) {
    for (const [value, label] of PERIODS) {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.value = value; b.textContent = label;
      b.addEventListener('click', () => { settings.period = value; saveSettings(); render(); });
      seg.append(b);
    }
    for (const id of ['before', 'after']) {
      const input = $(id);
      input.value = settings[id];
      input.addEventListener('input', () => {
        settings[id] = Number(input.value);
        $(id + '-out').textContent = input.value;
        saveSettings();
        render();
      });
    }
  }
  for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.value === settings.period));
  for (const id of ['before', 'after']) $(id + '-out').textContent = settings[id];
}

// ---- Grafer ----

const NS = 'http://www.w3.org/2000/svg';

function svgOf(el, W, H, label) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const add = (name, attrs, text) => {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  el.replaceChildren(svg);
  return add;
}

function niceStep(span, target) {
  const raw = span / target, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function lineChart(el, [t0, t1], series, opts) {
  const vals = series.flatMap((s) => s.pts.map((p) => p.v)).filter(Number.isFinite);
  if (!vals.length) { el.textContent = 'Ingen data i perioden.'; return; }
  const W = Math.max(320, el.clientWidth || 800), H = 260, L = 48, R = 12, T = 12, B = 28;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (opts.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const step = niceStep(hi - lo, 5);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const add = svgOf(el, W, H, opts.unit);
  for (let v = lo; v <= hi + step / 2; v += step) {
    add('line', { class: opts.zero && Math.abs(v) < step / 2 ? 'baseline' : 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) });
    add('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, Number(v.toFixed(2)).toLocaleString('nb-NO'));
  }
  const long = t1 - t0 > 400 * DAY;
  const xf = new Intl.DateTimeFormat('nb-NO', long ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  for (let i = 0; i <= 4; i++) {
    const t = new Date(t0.getTime() + (i / 4) * (t1 - t0));
    add('text', { x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, xf.format(t));
  }
  for (const s of series) {
    if (s.dots) {
      const r = s.pts.length > 400 ? 1.6 : 2.6;
      for (const p of s.pts) add('circle', { class: s.cls, cx: x(p.t), cy: y(p.v), r });
    } else if (s.pts.length) {
      // Brudd i linja der det går mer enn 60 dager mellom målinger (som 2016-2018).
      let seg = [];
      const flush = () => { if (seg.length) add('polyline', { class: s.cls, points: seg.join(' ') }); seg = []; };
      s.pts.forEach((p, i) => {
        if (i && p.t - s.pts[i - 1].t > 60 * DAY) flush();
        seg.push(`${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
      });
      flush();
    }
  }
}

// Avvik fra trend (vekt − trend) i snitt per ukedag, som regnearkets søylediagram.
function weekdayChart(el, points) {
  const sum = Array(7).fill(0), n = Array(7).fill(0);
  for (const p of points) {
    const d = (p.t.getDay() + 6) % 7; // mandag = 0
    sum[d] += p.value - p.trend; n[d]++;
  }
  const avg = sum.map((s, i) => (n[i] ? (s / n[i]) * 1000 : 0)); // gram
  const W = Math.max(320, el.clientWidth || 800), H = 220, L = 48, R = 12, T = 12, B = 28;
  const m = Math.max(50, ...avg.map(Math.abs));
  const step = niceStep(2 * m, 4), top = Math.ceil(m / step) * step;
  const y = (v) => T + (1 - (v + top) / (2 * top)) * (H - T - B);
  const add = svgOf(el, W, H, 'Avvik fra trend per ukedag');
  for (let v = -top; v <= top + step / 2; v += step) {
    add('line', { class: Math.abs(v) < step / 2 ? 'baseline' : 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) });
    add('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${Math.round(v)} g`);
  }
  const bw = (W - L - R) / 7;
  avg.forEach((v, i) => {
    const x0 = L + i * bw + bw * 0.18, w = bw * 0.64;
    add('rect', { class: v >= 0 ? 'bar-up' : 'bar-down', x: x0, width: w, y: Math.min(y(v), y(0)), height: Math.max(1, Math.abs(y(v) - y(0))) });
    add('text', { x: x0 + w / 2, y: v >= 0 ? y(v) - 4 : y(v) + 14, 'text-anchor': 'middle' }, n[i] ? `${v > 0 ? '+' : ''}${Math.round(v)}` : '–');
    add('text', { x: x0 + w / 2, y: H - 8, 'text-anchor': 'middle' }, WEEKDAYS[i].slice(0, 3));
  });
}

function renderList(weights, fats) {
  const fatAt = new Map(fats.map((f) => [Math.round(f.t / 6e4), f.value]));
  const table = document.createElement('table');
  table.className = 'weights';
  table.innerHTML = '<thead><tr><th>Tid</th><th class="num">Vekt</th><th class="num">Fett</th><th>Kilde</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const w of weights.slice(-20).reverse()) {
    const tr = document.createElement('tr');
    const fat = fatAt.get(Math.round(w.t / 6e4));
    const kilde = isSheet(w) ? 'Regneark' : 'Aria';
    for (const [text, cls] of [[when(w), ''], [fmt1(w.value) + ' kg', 'num'], [fat != null ? fmt1(fat) + ' %' : '–', 'num'], [kilde, '']]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  $('list').replaceChildren(table);
}

// ---- Oppstart ----

mountAuthBar($('auth'));
$('sync').addEventListener('click', () => sync(false));
$('sync-all').addEventListener('click', () => sync(true));
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => rows.length && render(), 200); });

if (!configured) {
  say('Innloggingen er ikke satt opp: js/firebase-config.js mangler verdiene fra Firebase.');
} else {
  onUser(async (user) => {
    currentUser = user;
    $('sync').hidden = !user || !googleClientId;
    $('sync-all').hidden = !user || !googleClientId;
    if (!user) {
      $('content').hidden = true;
      say('Appen er privat.', true);
      return;
    }
    say('Henter målinger …');
    try {
      await loadRows();
      say('');
      render();
    } catch (err) {
      say(err && err.code === 'permission-denied' ? 'Denne kontoen har ikke tilgang.' : 'Klarte ikke å lese data (' + (err.code || err.message) + ').');
    }
  });
}
