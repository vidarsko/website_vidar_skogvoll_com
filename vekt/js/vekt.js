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
// Analysene: trend som gaussisk glatting (lokal lineær regresjon med gaussiske vekter i tid,
// bredde σ fra en slider), vektendring som stigningstallet til samme linje (g/uke), og avvik fra
// trend per ukedag. Til 2026-11-19 var trenden regnearkets FORECAST over N målinger før og M
// etter. Se vekt_private/AGENTS.md.

import {
  getFirestore, collection, doc, getDocs, writeBatch, query, orderBy, where,
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

// Nettleseren husker målingene (localStorage), så en åpning leser bare de nyeste fra Firestore
// i stedet for alle (1 633 lesinger hver gang, nær gratisgrensa på 50 000 per døgn).
// Målinger slettes aldri og har faste ID-er, så nye kan flettes inn etter ID. Vinduet på tre
// dager bakover fanger veiinger som er lagret fra en annen enhet med litt eldre tid. En gang i
// uka hentes alt på nytt. Kopien slettes ved utlogging.
const CACHE_KEY = 'vekt-maalinger-v1';
const FULL_EVERY = 7 * 864e5;
const OVERLAP = 3 * 864e5;
let fullAt = 0;

const fromDoc = (d) => {
  const x = d.data();
  return { id: d.id, type: x.type, t: x.t.toDate(), value: x.value, kilde: x.kilde || '' };
};

function mergeRows(newRows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of newRows) byId.set(r.id, r);
  rows = [...byId.values()].sort((a, b) => a.t - b.t);
}

function writeCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      uid: currentUser.uid, fullAt, rows: rows.map((r) => ({ ...r, t: r.t.getTime() })),
    }));
  } catch (e) { /* full eller blokkert lagring: neste åpning leser alt */ }
}

function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
}

async function loadRows() {
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) {}
  if (cache && cache.uid === currentUser.uid && Date.now() - cache.fullAt < FULL_EVERY && cache.rows.length) {
    rows = cache.rows.map((r) => ({ ...r, t: new Date(r.t) }));
    fullAt = cache.fullAt;
    const from = new Date(rows[rows.length - 1].t.getTime() - OVERLAP);
    const snap = await getDocs(query(collection(db, 'maalinger'), where('t', '>=', from), orderBy('t')));
    mergeRows(snap.docs.map(fromDoc));
  } else {
    const snap = await getDocs(query(collection(db, 'maalinger'), orderBy('t')));
    rows = snap.docs.map(fromDoc);
    fullAt = Date.now();
  }
  writeCache();
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
    if (fresh.length) {
      await saveRows(fresh);
      mergeRows(fresh); // lagret nå, så ingen grunn til å lese alt på nytt
      writeCache();
    }
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


// ---- Analyse ----

const DAY = 864e5;
const SETTINGS_KEY = 'vekt-innstillinger';
const PERIODS = [['30', '30 dager'], ['90', '90 dager'], ['365', '1 år'], ['730', '2 år'], ['1825', '5 år'], ['all', 'Alt']];
const WEEKDAYS = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];
// Glattingen: σ i dager, fra 1 til 120. Slideren går 0-100 på log-skala, så de små verdiene,
// der forskjellene synes, får like mye plass som de store.
const SIGMA_MIN = 1, SIGMA_MAX = 120;
const sigmaAt = (pos) => Math.round(SIGMA_MIN * Math.pow(SIGMA_MAX / SIGMA_MIN, pos / 100));
const posOf = (sigma) => Math.round((100 * Math.log(sigma / SIGMA_MIN)) / Math.log(SIGMA_MAX / SIGMA_MIN));
let settings = { period: '365', sigma: 14 };
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  if (saved.period) settings.period = saved.period;
  if (Number.isFinite(saved.sigma)) settings.sigma = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, saved.sigma));
} catch (e) {}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

const dayKey = (t) => t.toLocaleDateString('sv-SE'); // YYYY-MM-DD i lokal tid
const isSheet = (r) => String(r.kilde).startsWith('regneark');

// Vekt der regnearkets veiinger faller bort de dagene Google har en.
function cleanWeights() {
  const all = rows.filter((r) => r.type === 'weight');
  const googleDays = new Set(all.filter((r) => !isSheet(r)).map((r) => dayKey(r.t)));
  return all.filter((r) => !(isSheet(r) && googleDays.has(dayKey(r.t)))).sort((a, b) => a.t - b.t);
}

// Gaussisk glatting: for hvert punkt en rett linje tilpasset målingene rundt, vektet med
// exp(−½(Δt/σ)²) etter avstanden i tid. Linja (ikke bare et vektet snitt) gjør at trenden ved
// siste veiing ikke dras mot eldre verdier, og stigningstallet er vektendringen.
// trend = linjens verdi i punktet, deriv = stigningen i gram per uke. Målinger lenger unna enn
// 3σ teller ikke (vekt under 1 %).
function trendOf(points, sigma) {
  const xs = points.map((p) => p.t / DAY);
  const reach = 3 * sigma;
  let lo = 0, hi = 0;
  return points.map((p, i) => {
    while (xs[i] - xs[lo] > reach) lo++;
    while (hi + 1 < points.length && xs[hi + 1] - xs[i] <= reach) hi++;
    let s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0;
    for (let j = lo; j <= hi; j++) {
      const d = xs[j] - xs[i], w = Math.exp(-0.5 * (d / sigma) ** 2), y = points[j].value;
      s0 += w; s1 += w * d; s2 += w * d * d; t0 += w * y; t1 += w * d * y;
    }
    const den = s0 * s2 - s1 * s1;
    const b = den > 1e-9 * s0 * s0 ? (s0 * t1 - s1 * t0) / den : 0;
    const a = (t0 - b * s1) / s0; // x = 0 i punktet selv
    return { t: p.t, value: p.value, trend: a, deriv: b * 1000 * 7, raw: p };
  });
}

const fmt1 = (v) => v.toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt0 = (v) => Math.round(v).toLocaleString('nb-NO');
const sign = (v) => (Math.round(v) > 0 ? '+' : Math.round(v) < 0 ? '−' : '');
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

  const sigma = settings.sigma;
  const all = trendOf(weights, sigma);
  const from = settings.period === 'all' ? weights[0].t : new Date(Date.now() - Number(settings.period) * DAY);
  const shown = all.filter((p) => p.t >= from);
  const fatAll = fats.length ? trendOf(fats, sigma) : [];
  const shownFat = fatAll.filter((p) => p.t >= from);
  const last = all[all.length - 1];

  $('kpi-weight').textContent = fmt1(weights[weights.length - 1].value) + ' kg';
  $('kpi-weight-sub').textContent = when(weights[weights.length - 1]);
  $('kpi-trend').textContent = fmt1(last.trend) + ' kg';
  $('kpi-trend-sub').textContent = `Gaussisk glatting, σ = ${sigma} ${sigma === 1 ? 'dag' : 'dager'}`;
  $('kpi-rate').textContent = sign(last.deriv) + fmt0(Math.abs(last.deriv)) + ' g/uke';
  const perMonth = (last.deriv * 30) / 7 / 1000;
  $('kpi-rate-sub').textContent = `${perMonth > 0.005 ? '+' : perMonth < -0.005 ? '−' : ''}${Math.abs(perMonth).toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg per 30 dager`;
  if (fats.length) {
    $('kpi-fat').textContent = fmt1(fats[fats.length - 1].value) + ' %';
    $('kpi-fat-sub').textContent = when(fats[fats.length - 1]);
  }

  const range = [shown.length ? shown[0].t : from, new Date()];
  const days = dayGroups(shown, fats);
  lineChart($('chart-weight'), range, [
    { pts: shown.map((p) => ({ t: p.t, v: p.value })), cls: 'weight-dot', dots: true },
    { pts: shown.map((p) => ({ t: p.t, v: p.trend })), cls: 'weight-trend' },
  ], { unit: 'kg', portrait: true, hover: { days, mark: (d) => d.trend } });
  lineChart($('chart-deriv'), range, [
    { pts: shown.map((p) => ({ t: p.t, v: p.deriv })), cls: 'deriv-line' },
  ], { unit: 'g/uke', zero: true, hover: { days, mark: (d) => d.deriv } });
  weekdayChart($('chart-weekday'), shown);
  if (shownFat.length) {
    lineChart($('chart-fat'), range, [
      { pts: shownFat.map((p) => ({ t: p.t, v: p.value })), cls: 'fat-dot', dots: true },
      { pts: shownFat.map((p) => ({ t: p.t, v: p.trend })), cls: 'fat-trend' },
    ], { unit: '%' });
    $('fat-panel').hidden = false;
  } else {
    $('fat-panel').hidden = true;
  }
  renderMass(weights, fats, from, range);
  $('period-sub').textContent = `${shown.length} veiinger i perioden. Hold over grafen for å se dagen.`;
  renderList(weights, fats);
}

// Én oppføring per dag med veiing, for hover: trenden og vektendringen ved dagens siste
// veiing, og alle veiingene den dagen (med fettprosent fra samme veiing, når den finnes).
function dayGroups(shown, fats) {
  const fatAt = new Map(fats.map((f) => [Math.round(f.t / 6e4), f.value]));
  const byDay = new Map();
  for (const p of shown) {
    const k = dayKey(p.t);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }
  return [...byDay.values()].map((ps) => {
    const end = ps[ps.length - 1];
    const lines = ps.map((p) => {
      const fat = fatAt.get(Math.round(p.t / 6e4));
      const time = hasTime(p.raw) ? timeFmt.format(p.t) : 'Veiing';
      return [time, fmt1(p.value) + ' kg' + (fat != null ? ' · ' + fmt1(fat) + ' %' : '')];
    });
    return {
      t: end.t, trend: end.trend, deriv: end.deriv,
      title: dayFmt.format(end.t),
      rows: [['Trend', fmt1(end.trend) + ' kg', 'trend'], ['Endring', sign(end.deriv) + fmt0(Math.abs(end.deriv)) + ' g/uke', 'deriv'],
        ...lines.map(([a, b]) => [a, b, 'dot'])],
    };
  });
}

// Fettmasse og fettfri masse: for hver fettmåling, vekta fra samme veiing (samme minutt).
function renderMass(weights, fats, from, range) {
  const weightAt = new Map(weights.map((w) => [Math.round(w.t / 6e4), w.value]));
  const fatMass = [], lean = [];
  for (const f of fats) {
    const w = weightAt.get(Math.round(f.t / 6e4));
    if (w == null) continue;
    fatMass.push({ t: f.t, value: (w * f.value) / 100 });
    lean.push({ t: f.t, value: w - (w * f.value) / 100 });
  }
  const any = fatMass.some((p) => p.t >= from);
  $('mass-panels').hidden = !any;
  if (!any) return;
  for (const [series, el, sub, cls] of [[fatMass, 'chart-fatmass', 'fatmass-sub', 'fat'], [lean, 'chart-lean', 'lean-sub', 'lean']]) {
    const tr = trendOf(series, settings.sigma).filter((p) => p.t >= from);
    lineChart($(el), range, [
      { pts: tr.map((p) => ({ t: p.t, v: p.value })), cls: cls + '-dot', dots: true },
      { pts: tr.map((p) => ({ t: p.t, v: p.trend })), cls: cls + '-trend' },
    ], { unit: 'kg' });
    const first = tr[0].trend, last = tr[tr.length - 1].trend, d = last - first;
    const base = sub === 'fatmass-sub' ? 'Vekt × fettprosent, i kilo.' : 'Alt som ikke er fett: muskler, skjelett, organer, vann. I kilo.';
    $(sub).textContent = `${base} Nå ${fmt1(last)} kg, ${d >= 0 ? '+' : '−'}${fmt1(Math.abs(d))} kg i perioden.`;
  }
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
    const input = $('smooth');
    input.value = posOf(settings.sigma);
    let frame = 0;
    input.addEventListener('input', () => {
      settings.sigma = sigmaAt(Number(input.value));
      $('smooth-out').textContent = sigmaText();
      saveSettings();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    });
  }
  for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.value === settings.period));
  $('smooth-out').textContent = sigmaText();
  $('smooth').setAttribute('aria-valuetext', sigmaText());
}
const sigmaText = () => `σ = ${settings.sigma} ${settings.sigma === 1 ? 'dag' : 'dager'}`;

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

// Stående format for vektgrafen: dobbelt så høy som bred, men aldri høyere enn skjermen.
function chartHeight(W, portrait) {
  if (!portrait) return 260;
  return Math.round(Math.min(2 * W, Math.max(440, window.innerHeight - 140)));
}

function lineChart(el, [t0, t1], series, opts) {
  const vals = series.flatMap((s) => s.pts.map((p) => p.v)).filter(Number.isFinite);
  if (!vals.length) { el.textContent = 'Ingen data i perioden.'; return; }
  const W = Math.max(280, el.clientWidth || 800), H = chartHeight(W, opts.portrait), L = 48, R = 12, T = 12, B = 28;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (opts.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const step = niceStep(hi - lo, Math.max(5, Math.round(H / 70)));
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
  const ticks = W < 420 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const t = new Date(t0.getTime() + (i / ticks) * (t1 - t0));
    add('text', { x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle' }, xf.format(t));
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
  if (opts.hover && opts.hover.days.length) addHover(el, add, { W, H, T, B, L, R, x, y }, opts.hover);
}

// Hold over grafen (eller dra med fingeren): en loddrett strek ved nærmeste dag med veiing, en
// ring på kurven og en boks med trenden og dagens veiinger.
function addHover(el, add, g, { days, mark }) {
  const line = add('line', { class: 'hover-line', y1: g.T, y2: g.H - g.B, visibility: 'hidden' });
  const ring = add('circle', { class: 'hover-dot', r: 5, visibility: 'hidden' });
  const hit = add('rect', { class: 'hover-hit', x: g.L, y: 0, width: g.W - g.L - g.R, height: g.H });
  const svg = el.firstChild;
  const xs = days.map((d) => g.x(d.t));
  const show = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) * g.W) / box.width;
    let i = 0, best = Infinity;
    for (let k = 0; k < xs.length; k++) { const d = Math.abs(xs[k] - px); if (d < best) { best = d; i = k; } }
    const d = days[i];
    line.setAttribute('x1', xs[i]); line.setAttribute('x2', xs[i]);
    ring.setAttribute('cx', xs[i]); ring.setAttribute('cy', g.y(mark(d)));
    line.setAttribute('visibility', 'visible'); ring.setAttribute('visibility', 'visible');
    showTip(d, ev.clientX, ev.clientY);
  };
  const hide = () => {
    line.setAttribute('visibility', 'hidden'); ring.setAttribute('visibility', 'hidden');
    $('tooltip').hidden = true;
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', (ev) => { if (ev.pointerType !== 'touch') hide(); });
  el._hideHover = hide;
}

function showTip(d, cx, cy) {
  const tip = $('tooltip');
  tip.replaceChildren();
  const title = document.createElement('div');
  title.className = 'tt-title'; title.textContent = d.title;
  tip.append(title);
  for (const [label, value, kind] of d.rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const i = document.createElement('i'); i.className = 'tt-' + kind;
    const b = document.createElement('b'); b.textContent = value;
    const s = document.createElement('span'); s.textContent = label;
    row.append(i, s, b);
    tip.append(row);
  }
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = cx + 16, top = cy + 16;
  if (left + w > window.innerWidth - 8) left = cx - w - 16;
  if (top + h > window.innerHeight - 8) top = cy - h - 16;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}

// Et trykk utenfor grafene skjuler boksen (på telefon finnes ingen «mus forlater»).
document.addEventListener('pointerdown', (ev) => {
  if (!ev.target.closest || !ev.target.closest('.hover-hit')) {
    for (const c of document.querySelectorAll('.chart')) if (c._hideHover) c._hideHover();
  }
});
document.addEventListener('scroll', () => { $('tooltip').hidden = true; }, { passive: true });

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
      rows = [];
      clearCache();
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
