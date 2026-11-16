// Vekt og fettprosent fra Fitbit Aria, via Google Health API.
//
// Flyt: Vidar er logget inn med Firebase (Google). Knappen «Hent fra vekta» ber Google om en
// kortvarig tilgangsnøkkel med lesetilgang til målinger (Google Identity Services, i nettleseren).
// Nøkkelen brukes til å hente nye veiinger, som lagres i Firestore (samlingen «maalinger»), og
// siden viser alltid det som ligger i Firestore. Ingen nøkkel lagres noe sted; den lever i
// minnet til fanen lukkes.
//
// Hvorfor ikke automatisk i bakgrunnen: Google Health-appen vår er i «Testing»-modus, og der
// utløper refresh-nøkler etter 7 dager. En nattlig jobb ville måttet logges inn på nytt hver uke.
// Se kalorier_private/AGENTS.md.

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
    return { id: d.id, type: x.type, t: x.t.toDate(), value: x.value };
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

async function fetchType(token, apiType, field, since) {
  const out = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      filter: `${field}.sample_time.physical_time >= "${since.toISOString()}"`,
      pageSize: '1000',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await fetch(`${API}/${apiType}/dataPoints?${params}`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) throw new Error(`Google Health svarte ${r.status} for ${apiType}`);
    const json = await r.json();
    for (const p of json.dataPoints || []) {
      const m = p[field];
      if (!m || !m.sampleTime || !m.sampleTime.physicalTime) continue;
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

async function sync() {
  const button = $('sync');
  button.disabled = true;
  say('Henter fra Google …');
  try {
    const token = await getToken();
    const last = rows.length ? rows[rows.length - 1].t : null;
    // Litt overlapp, så en veiing som kom sent inn ikke faller mellom to henting.
    const since = last
      ? new Date(last.getTime() - 3 * 864e5)
      : new Date(Date.now() - FIRST_SYNC_DAYS * 864e5);
    const fetched = [
      ...(await fetchType(token, 'weight', 'weight', since)),
      ...(await fetchType(token, 'body-fat', 'bodyFat', since)),
    ];
    const known = new Set(rows.map((r) => r.id));
    const fresh = fetched.filter((r) => !known.has(r.id));
    if (fresh.length) await saveRows(fresh);
    await loadRows();
    render();
    say(fresh.length ? `Hentet ${fresh.length} nye målinger.` : 'Ingen nye målinger.');
  } catch (err) {
    say('Klarte ikke å hente: ' + err.message);
  } finally {
    button.disabled = false;
  }
}

// ---- Visning ----

const kg = (v) => v.toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const shortFmt = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' });

function movingAverage(list, n) {
  return list.map((p, i) => {
    const w = list.slice(Math.max(0, i - n + 1), i + 1);
    return { t: p.t, value: w.reduce((s, x) => s + x.value, 0) / w.length };
  });
}

function render() {
  const weights = rows.filter((r) => r.type === 'weight');
  const fats = rows.filter((r) => r.type === 'bodyFat');
  $('content').hidden = false;

  if (!weights.length) {
    say('Ingen veiinger lagret ennå. Trykk «Hent fra vekta».');
    $('chart').replaceChildren();
    $('list').replaceChildren();
    return;
  }

  const lastW = weights[weights.length - 1];
  $('kpi-weight').textContent = kg(lastW.value) + ' kg';
  $('kpi-weight-sub').textContent = dayFmt.format(lastW.t);
  if (fats.length) {
    const lastF = fats[fats.length - 1];
    $('kpi-fat').textContent = kg(lastF.value) + ' %';
    $('kpi-fat-sub').textContent = dayFmt.format(lastF.t);
  }
  const trend = movingAverage(weights, 7);
  const now = trend[trend.length - 1].value;
  const monthAgo = trend.filter((p) => p.t <= new Date(Date.now() - 30 * 864e5)).pop();
  $('kpi-trend').textContent = kg(now) + ' kg';
  $('kpi-trend-sub').textContent = monthAgo
    ? `${now - monthAgo.value <= 0 ? '−' : '+'}${kg(Math.abs(now - monthAgo.value))} kg siste 30 dager`
    : '';

  renderChart(weights, trend);
  renderList(weights, fats);
}

function renderChart(weights, trend) {
  const from = new Date(Date.now() - 90 * 864e5);
  const pts = weights.filter((p) => p.t >= from);
  const line = trend.filter((p) => p.t >= from);
  const el = $('chart');
  if (!pts.length) { el.textContent = 'Ingen veiinger siste 90 dager.'; return; }

  const W = Math.max(320, el.clientWidth || 800), H = 240, L = 44, R = 12, T = 12, B = 28;
  const vals = pts.map((p) => p.value).concat(line.map((p) => p.value));
  const lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
  const x = (t) => L + ((t - from) / (Date.now() - from)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Vekt siste 90 dager');
  const add = (name, attrs, text) => {
    const e = document.createElementNS(ns, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text) e.textContent = text;
    svg.append(e);
    return e;
  };
  const step = hi - lo > 6 ? 2 : 1;
  for (let v = lo; v <= hi; v += step) {
    add('line', { class: 'gridline', x1: L, x2: W - R, y1: y(v), y2: y(v) });
    add('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v));
  }
  for (let i = 0; i <= 3; i++) {
    const t = new Date(from.getTime() + (i / 3) * (Date.now() - from));
    add('text', { x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === 3 ? 'end' : 'middle' }, shortFmt.format(t));
  }
  for (const p of pts) add('circle', { class: 'weight-dot', cx: x(p.t), cy: y(p.value), r: 3 });
  add('polyline', { class: 'weight-trend', points: line.map((p) => `${x(p.t)},${y(p.value)}`).join(' ') });
  el.replaceChildren(svg);
}

function renderList(weights, fats) {
  // Fettprosent fra samme veiing har (nesten) samme tidspunkt; slå dem sammen per minutt.
  const fatAt = new Map(fats.map((f) => [Math.round(f.t / 6e4), f.value]));
  const table = document.createElement('table');
  table.className = 'weights';
  table.innerHTML = '<thead><tr><th>Tid</th><th class="num">Vekt</th><th class="num">Fett</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const w of weights.slice(-20).reverse()) {
    const tr = document.createElement('tr');
    const fat = fatAt.get(Math.round(w.t / 6e4));
    for (const [text, cls] of [[dayFmt.format(w.t), ''], [kg(w.value) + ' kg', 'num'], [fat != null ? kg(fat) + ' %' : '–', 'num']]) {
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
$('sync').addEventListener('click', sync);

if (!configured) {
  say('Innloggingen er ikke satt opp: js/firebase-config.js mangler verdiene fra Firebase.');
} else {
  onUser(async (user) => {
    currentUser = user;
    $('sync').hidden = !user || !googleClientId;
    if (!user) {
      $('content').hidden = true;
      say('Appen er privat.', true);
      return;
    }
    if (!googleClientId) say('Koblingen til Google Health er ikke satt opp ennå (googleClientId mangler).');
    try {
      await loadRows();
      render();
    } catch (err) {
      say(err && err.code === 'permission-denied' ? 'Denne kontoen har ikke tilgang.' : 'Klarte ikke å lese data (' + (err.code || err.message) + ').');
    }
  });
}
