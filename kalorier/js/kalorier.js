// Kaloriappen: rask logging av mat og trening, med dagsbudsjett.
//
// Alt innhold kommer fra Firestore etter innlogging. Oppsettet (kategorier, omregninger,
// ikoner, budsjett og reglene for Lose It-importen) ligger i dokumentet kalorioppsett/oppsett,
// ikke her: denne fila er offentlig, og skal ikke si noe om hva Vidar spiser. Oppsettet skrives
// fra tools/kalorier_oppsett.json av workflowen kalorier.yml.
//
// Matloggen ligger i samlingen «matlogg», én oppføring per dokument:
//   t (tid), kat (kategori-id), mengde (i kategoriens enhet), kcal (+ mat, − trening, netto),
//   notat (valgfritt; Lose It-navnet ved import), kilde ('app' | 'loseit'), lagret.
// Se kalorier_private/AGENTS.md.

import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, deleteDoc, writeBatch,
  query, where, orderBy, Timestamp, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, configured, mountAuthBar, onUser, signIn, showError } from '/js/auth.js';

const $ = (id) => document.getElementById(id);
const db = configured ? getFirestore(app) : null;
const LOG = 'matlogg';
const WEEKS_STEP = 10;

let setup = null;
const cats = new Map();
let entries = []; // { id, t: Date, kat, mengde, kcal, notat, kilde }
let loadedFrom = null;
let day = startOfDay(new Date());
let followToday = true; // står på «I dag»: hopp til ny dag over midnatt

// ---- Datoer og tall ----

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function mondayOf(d) { return addDays(startOfDay(d), -((d.getDay() + 6) % 7)); }
const dayKey = (d) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD, lokal tid
const isToday = (d) => dayKey(d) === dayKey(new Date());

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
}

const fmt0 = (v) => Math.round(v).toLocaleString('nb-NO');
const fmtNum = (v) => Number(v).toLocaleString('nb-NO', { maximumFractionDigits: 2 });
const hhmm = (d) => d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
const longDate = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' });
const WEEKDAYS = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];

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

// ---- Oppsett og budsjett ----

function budgetFor(d) {
  const b = setup.budsjett;
  return b.dagsbudsjett + (b.helgedager.includes(d.getDay()) ? b.helgetillegg : 0);
}
function weekBudget() {
  let s = 0;
  for (let i = 0; i < 7; i++) s += budgetFor(addDays(mondayOf(new Date()), i));
  return s;
}

function amountText(cat, m) {
  if (cat.enhet === 'kcal') return fmt0(m) + ' kcal';
  return fmtNum(m) + ' ' + (m === 1 ? cat.enhet : cat.enheter);
}
function kcalOf(cat, m) {
  const k = Math.round(m * cat.kcal);
  return cat.type === 'trening' ? -k : k;
}
function iconSvg(cat, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Ikonene kommer fra oppsettet i Firestore, som bare tjenestekontoen kan skrive.
  if (cat && cat.ikon) svg.innerHTML = cat.ikon;
  return svg;
}

// ---- Firestore ----

function fromDoc(d) {
  const x = d.data();
  return { id: d.id, t: x.t.toDate(), kat: x.kat, mengde: x.mengde, kcal: x.kcal, notat: x.notat || '', kilde: x.kilde || '' };
}

async function loadSetup() {
  const snap = await getDoc(doc(db, 'kalorioppsett', 'oppsett'));
  if (!snap.exists()) return false;
  setup = snap.data();
  cats.clear();
  for (const c of setup.kategorier) cats.set(c.id, c);
  return true;
}

// Henter alt fra og med `from` som ikke allerede er lastet.
async function ensureFrom(from) {
  if (loadedFrom && from >= loadedFrom) return;
  const parts = [where('t', '>=', Timestamp.fromDate(from))];
  if (loadedFrom) parts.push(where('t', '<', Timestamp.fromDate(loadedFrom)));
  const snap = await getDocs(query(collection(db, LOG), ...parts, orderBy('t')));
  entries = snap.docs.map(fromDoc).concat(entries);
  loadedFrom = from;
}

async function reloadAll() {
  const from = loadedFrom;
  entries = []; loadedFrom = null;
  await ensureFrom(from);
}

// ---- Visning ----

function entriesOn(d) {
  const k = dayKey(d);
  return entries.filter((e) => dayKey(e.t) === k).sort((a, b) => a.t - b.t);
}

function sums(list) {
  let mat = 0, trening = 0;
  for (const e of list) (e.kcal >= 0 ? (mat += e.kcal) : (trening += e.kcal));
  return { mat, trening, netto: mat + trening };
}

function statusEl(el, diff) {
  el.classList.toggle('over', diff > 0);
  el.classList.toggle('under', diff <= 0);
  el.textContent = diff > 0 ? fmt0(diff) + ' over' : fmt0(-diff) + ' under';
}

function render() {
  $('content').hidden = false;
  renderDay();
  renderWeek();
  renderWeeks();
}

function renderDay() {
  const yesterday = dayKey(addDays(new Date(), -1));
  $('day-title').textContent = isToday(day) ? 'I dag' : dayKey(day) === yesterday ? 'I går' : longDate.format(day).split(' ')[0].replace(/^./, (c) => c.toUpperCase());
  $('day-date').textContent = longDate.format(day);
  $('next').disabled = isToday(day);
  $('today').disabled = isToday(day);

  const list = entriesOn(day);
  const s = sums(list), budget = budgetFor(day);
  $('sum-netto').textContent = fmt0(s.netto);
  $('sum-budget').textContent = fmt0(budget);
  statusEl($('sum-status'), s.netto - budget);
  const fill = $('meter-fill');
  fill.style.width = Math.max(0, Math.min(1, s.netto / budget)) * 100 + '%';
  fill.classList.toggle('over', s.netto > budget);
  $('sum-parts').textContent = `Mat ${fmt0(s.mat)} · Trening ${s.trening ? '−' + fmt0(-s.trening) : '0'}`;

  const ul = $('entries');
  ul.replaceChildren();
  for (const e of list) {
    const cat = cats.get(e.kat);
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'entry';
    const time = document.createElement('span'); time.className = 'e-time'; time.textContent = hhmm(e.t);
    const icon = document.createElement('span'); icon.className = 'e-icon'; icon.append(iconSvg(cat, 28));
    const name = document.createElement('span'); name.className = 'e-name';
    name.textContent = cat ? cat.navn : e.kat;
    const sub = document.createElement('small');
    sub.textContent = [cat ? amountText(cat, e.mengde) : fmtNum(e.mengde), e.notat].filter(Boolean).join(' · ');
    name.append(sub);
    const kcal = document.createElement('span'); kcal.className = 'e-kcal' + (e.kcal < 0 ? ' neg' : '');
    kcal.textContent = (e.kcal < 0 ? '−' : '') + fmt0(Math.abs(e.kcal));
    b.append(time, icon, name, kcal);
    b.addEventListener('click', () => openEntry(cat, e));
    li.append(b);
    ul.append(li);
  }
  $('entries-empty').hidden = list.length > 0;
}

function renderWeek() {
  const mon = mondayOf(day);
  $('week-title').textContent = 'Uke ' + isoWeek(mon);
  $('week-sub').textContent = `${shortDate.format(mon)} – ${shortDate.format(addDays(mon, 6))} · mål ${fmt0(weekBudget())} kcal`;
  const wrap = $('week-days');
  wrap.replaceChildren();
  const now = startOfDay(new Date());
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const list = entriesOn(d), s = sums(list), budget = budgetFor(d);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'wd';
    if (dayKey(d) === dayKey(day)) b.setAttribute('aria-current', 'date');
    b.disabled = d > now;
    const name = document.createElement('span'); name.className = 'wd-name'; name.textContent = WEEKDAYS[i];
    const val = document.createElement('span'); val.className = 'wd-val';
    const st = document.createElement('span'); st.className = 'wd-status status';
    if (list.length) {
      val.textContent = fmt0(s.netto);
      const diff = s.netto - budget;
      st.classList.add(diff > 0 ? 'over' : 'under');
      st.textContent = (diff > 0 ? '+' : '−') + fmt0(Math.abs(diff));
    } else {
      val.textContent = '–';
      st.textContent = d > now ? '' : 'ikke logget';
    }
    const bud = document.createElement('span'); bud.className = 'wd-budget'; bud.textContent = 'av ' + fmt0(budget);
    b.append(name, val, bud, st);
    b.addEventListener('click', () => goTo(d));
    wrap.append(b);
  }
}

function renderWeeks() {
  const thisMon = mondayOf(new Date());
  const goal = weekBudget();
  $('weeks-sub').textContent = `Netto mot ukemålet på ${fmt0(goal)} kcal.`;
  const table = document.createElement('table');
  table.className = 'weeks';
  table.innerHTML = '<thead><tr><th>Uke</th><th>Datoer</th><th>Netto</th><th>Over/under</th><th>Dager</th></tr></thead>';
  const body = document.createElement('tbody');
  for (let mon = addDays(thisMon, -7); mon >= loadedFrom; mon = addDays(mon, -7)) {
    let netto = 0, logged = 0;
    for (let i = 0; i < 7; i++) {
      const list = entriesOn(addDays(mon, i));
      if (list.length) { logged++; netto += sums(list).netto; }
    }
    const tr = document.createElement('tr');
    if (!logged) tr.className = 'muted';
    const diff = netto - goal;
    const cells = [
      null,
      `${shortDate.format(mon)} – ${shortDate.format(addDays(mon, 6))}`,
      logged ? fmt0(netto) : '–',
      null,
      `${logged}/7`,
    ];
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      if (i === 0) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'link';
        b.textContent = String(isoWeek(mon));
        b.setAttribute('aria-label', 'Vis uke ' + isoWeek(mon));
        b.addEventListener('click', () => goTo(addDays(mon, 6)));
        td.append(b);
      } else if (i === 3) {
        if (logged) {
          const s = document.createElement('span'); s.className = 'status';
          statusEl(s, diff);
          td.append(s);
        } else td.textContent = '–';
      } else td.textContent = text;
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(body);
  $('weeks').replaceChildren(table);
}

function renderGrids() {
  for (const type of ['mat', 'trening']) {
    const grid = $('grid-' + type);
    grid.replaceChildren();
    for (const cat of setup.kategorier.filter((c) => c.type === type)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cat';
      const icon = document.createElement('span'); icon.className = 'cat-icon'; icon.append(iconSvg(cat, 40));
      const name = document.createElement('span'); name.className = 'cat-name'; name.textContent = cat.kort || cat.navn;
      b.append(icon, name);
      b.addEventListener('click', () => openEntry(cat, null));
      grid.append(b);
    }
  }
}

async function goTo(d) {
  day = startOfDay(d);
  followToday = isToday(day);
  try {
    await ensureFrom(mondayOf(day));
  } catch (err) {
    say('Klarte ikke å hente dagen (' + (err.code || err.message) + ').');
  }
  render();
}

// ---- Logging ----

let editing = null;  // oppføringen som redigeres, eller null for ny
let current = null;  // kategorien i dialogen
let kcalLocked = null; // kcal fra en importert oppføring, til slideren flyttes

function openEntry(cat, entry) {
  if (!cat) return;
  current = cat; editing = entry; kcalLocked = entry ? entry.kcal : null;
  $('entry-icon').replaceChildren(iconSvg(cat, 44));
  $('entry-title').textContent = cat.navn;
  $('entry-info').textContent = cat.info || '';
  $('entry-info').hidden = !cat.info;
  $('entry-conv').textContent = cat.enhet === 'kcal'
    ? 'Antall kcal, omtrent'
    : `1 ${cat.enhet}${cat.str ? ' (' + cat.str + ')' : ''} = ${fmtNum(cat.kcal)} kcal${cat.type === 'trening' ? ' netto' : ''}`;

  const r = $('entry-range');
  const value = entry ? entry.mengde : cat.std;
  const offGrid = Math.abs(Math.round((value - cat.min) / cat.steg) * cat.steg + cat.min - value) > 1e-9;
  r.min = Math.min(cat.min, value);
  r.max = Math.max(cat.maks, value);
  r.step = offGrid ? 'any' : cat.steg;
  r.value = value;

  const t = entry ? entry.t : new Date();
  $('entry-time').value = hhmm(t);
  $('entry-note').value = entry ? entry.notat : '';
  $('entry-note-field').hidden = !(cat.notat || (entry && entry.notat));
  $('entry-delete').hidden = !entry;
  $('entry-save').textContent = entry ? 'Lagre' : 'Legg inn';
  updateDialog();
  $('entry').showModal();
  $('entry-save').focus();
}

function updateDialog() {
  const m = Number($('entry-range').value);
  $('entry-amount').textContent = amountText(current, m);
  const k = kcalLocked != null ? kcalLocked : kcalOf(current, m);
  $('entry-kcal').textContent = (k < 0 ? '−' : '') + fmt0(Math.abs(k));
}

function closeEntry() { $('entry').close(); }

async function saveEntry(ev) {
  ev.preventDefault();
  const [h, mi] = ($('entry-time').value || '12:00').split(':').map(Number);
  const base = editing ? editing.t : day;
  const t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi);
  const mengde = Number($('entry-range').value);
  const data = {
    t: Timestamp.fromDate(t),
    kat: current.id,
    mengde: Math.round(mengde * 100) / 100,
    kcal: kcalLocked != null ? kcalLocked : kcalOf(current, mengde),
    notat: $('entry-note').value.trim(),
    kilde: editing ? editing.kilde || 'app' : 'app',
    lagret: serverTimestamp(),
  };
  const cat = current, wasEditing = editing;
  closeEntry();
  try {
    let id;
    if (wasEditing) {
      id = wasEditing.id;
      await setDoc(doc(db, LOG, id), data);
      entries = entries.filter((e) => e.id !== id);
    } else {
      id = (await addDoc(collection(db, LOG), data)).id;
    }
    const saved = { id, t, kat: data.kat, mengde: data.mengde, kcal: data.kcal, notat: data.notat, kilde: data.kilde };
    entries.push(saved);
    render();
    const what = `${cat.navn}, ${(data.kcal < 0 ? '−' : '') + fmt0(Math.abs(data.kcal))} kcal`;
    if (wasEditing) toast('Lagret: ' + what, () => restore(wasEditing));
    else toast('Lagt inn: ' + what, () => remove(saved, true));
  } catch (err) {
    say('Klarte ikke å lagre (' + (err.code || err.message) + ').');
  }
}

async function remove(entry, quiet) {
  await deleteDoc(doc(db, LOG, entry.id));
  entries = entries.filter((e) => e.id !== entry.id);
  render();
  if (!quiet) toast('Slettet: ' + (cats.get(entry.kat) || {}).navn, () => restore(entry));
}

async function restore(entry) {
  await setDoc(doc(db, LOG, entry.id), {
    t: Timestamp.fromDate(entry.t), kat: entry.kat, mengde: entry.mengde, kcal: entry.kcal,
    notat: entry.notat, kilde: entry.kilde, lagret: serverTimestamp(),
  });
  entries = entries.filter((e) => e.id !== entry.id).concat([entry]);
  render();
}

let toastTimer;
let undoFn = null;
function toast(text, undo) {
  $('toast-text').textContent = text;
  undoFn = undo;
  $('toast-undo').hidden = !undo;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; undoFn = null; }, 6000);
}

// ---- Import fra Lose It ----

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// cyrb53: kort, stabil hash, så samme Lose It-rad alltid får samme dokument-ID.
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

const num = (s) => Number(String(s || '0').replace(/,/g, '')) || 0;

function loseItDate(s, hm) {
  const [mo, d, y] = s.split('/').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi);
}

function classify(name, icon, type) {
  const list = setup.kategorier.filter((c) => c.type === type);
  for (const c of list) if (c.loseit && new RegExp(c.loseit, 'i').test(name)) return c;
  for (const c of list) if ((c.loseit_ikoner || []).includes(icon)) return c;
  return cats.get(type === 'mat' ? 'annet' : 'annen_trening');
}

let pending = [];

async function prepareImport() {
  const L = setup.loseit;
  const earliest = new Date(L.tidligste_dato + 'T00:00:00');
  const out = [], seen = new Map();
  let deleted = 0, tooEarly = 0, skipped = 0;
  const idFor = (prefix, r) => {
    const k = prefix + Object.values(r).join('|');
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return `loseit_${prefix}_${hash(k + '#' + n)}`;
  };
  const food = $('file-food').files[0], ex = $('file-ex').files[0];
  if (food) {
    for (const r of parseCSV(await food.text())) {
      if (r.Deleted !== '0') { deleted++; continue; }
      const t = loseItDate(r.Date, L.tider[r.Meal] || '12:00');
      if (t < earliest) { tooEarly++; continue; }
      const cat = classify(r.Name, r.Icon, 'mat');
      const kcal = Math.round(num(r.Calories));
      out.push({ id: idFor('m', r), t, kat: cat.id, mengde: Math.round((kcal / cat.kcal) * 100) / 100, kcal, notat: r.Name });
    }
  }
  if (ex) {
    for (const r of parseCSV(await ex.text())) {
      if (r.Deleted !== '0') { deleted++; continue; }
      if ((L.hopp_over_trening || []).includes(r.Name)) { skipped++; continue; }
      const t = loseItDate(r.Date, L.tider.trening);
      if (t < earliest) { tooEarly++; continue; }
      const cat = classify(r.Name, '', 'trening');
      const min = num(r.Quantity);
      const net = Math.max(0, -num(r.Calories) - L.hvileforbruk_per_min * min);
      const mengde = cat.enhet === 'time' ? min / 60 : min;
      out.push({ id: idFor('t', r), t, kat: cat.id, mengde: Math.round(mengde * 100) / 100, kcal: -Math.round(net), notat: r.Name });
    }
  }
  pending = out;
  renderPreview({ deleted, tooEarly, skipped });
}

function renderPreview(skip) {
  const box = $('import-preview');
  box.replaceChildren();
  $('import-run').disabled = !pending.length;
  $('import-run').textContent = pending.length ? `Importer ${fmt0(pending.length)} rader` : 'Importer';
  if (!pending.length) { $('import-status').textContent = ''; return; }
  const by = new Map();
  for (const e of pending) {
    const x = by.get(e.kat) || { n: 0, kcal: 0 };
    x.n++; x.kcal += e.kcal; by.set(e.kat, x);
  }
  const table = document.createElement('table');
  table.className = 'weeks';
  table.innerHTML = '<thead><tr><th>Kategori</th><th>Rader</th><th>kcal</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const cat of setup.kategorier) {
    const x = by.get(cat.id);
    if (!x) continue;
    const tr = document.createElement('tr');
    for (const text of [cat.navn, fmt0(x.n), fmt0(x.kcal)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  box.append(table);
  const ts = pending.map((e) => e.t).sort((a, b) => a - b);
  const notes = [`${shortDate.format(ts[0])} ${ts[0].getFullYear()} – ${shortDate.format(ts[ts.length - 1])} ${ts[ts.length - 1].getFullYear()}`];
  if (skip.deleted) notes.push(`${skip.deleted} slettet i Lose It`);
  if (skip.tooEarly) notes.push(`${skip.tooEarly} med dato før ${setup.loseit.tidligste_dato}`);
  if (skip.skipped) notes.push(`${skip.skipped} treningsøkter uten kcal (${setup.loseit.hopp_over_trening.join(', ')})`);
  if (notes.length > 1) $('import-status').textContent = notes[0] + '. Hoppes over: ' + notes.slice(1).join(', ') + '.';
  else $('import-status').textContent = notes[0] + '.';
}

async function runImport() {
  const button = $('import-run');
  button.disabled = true;
  try {
    for (let i = 0; i < pending.length; i += 400) {
      const batch = writeBatch(db);
      for (const e of pending.slice(i, i + 400)) {
        batch.set(doc(db, LOG, e.id), {
          t: Timestamp.fromDate(e.t), kat: e.kat, mengde: e.mengde, kcal: e.kcal,
          notat: e.notat, kilde: 'loseit', lagret: serverTimestamp(),
        });
      }
      await batch.commit();
      $('import-status').textContent = `Skrevet ${fmt0(Math.min(i + 400, pending.length))} av ${fmt0(pending.length)} …`;
    }
    const n = pending.length;
    pending = [];
    await reloadAll();
    render();
    $('import-status').textContent = `Importert ${fmt0(n)} rader. Å importere samme filer på nytt lager ikke dobbelt opp.`;
    button.textContent = 'Importer';
  } catch (err) {
    $('import-status').textContent = 'Importen stoppet (' + (err.code || err.message) + '). Det som ble skrevet, ligger der; kjør på nytt for resten.';
    button.disabled = false;
  }
}

// ---- Oppstart ----

mountAuthBar($('auth'));
$('prev').addEventListener('click', () => goTo(addDays(day, -1)));
$('next').addEventListener('click', () => goTo(addDays(day, 1)));
$('today').addEventListener('click', () => goTo(new Date()));
$('more-weeks').addEventListener('click', async () => {
  await ensureFrom(addDays(loadedFrom, -7 * WEEKS_STEP));
  render();
});
$('entry-range').addEventListener('input', () => { kcalLocked = null; updateDialog(); });
$('entry-form').addEventListener('submit', saveEntry);
$('entry-cancel').addEventListener('click', closeEntry);
$('entry-close').addEventListener('click', closeEntry);
$('entry-delete').addEventListener('click', () => {
  const e = editing;
  closeEntry();
  remove(e).catch((err) => say('Klarte ikke å slette (' + (err.code || err.message) + ').'));
});
// Klikk utenfor dialogen lukker den.
$('entry').addEventListener('click', (ev) => { if (ev.target === $('entry')) closeEntry(); });
$('toast-undo').addEventListener('click', () => {
  const fn = undoFn;
  $('toast').hidden = true; undoFn = null;
  if (fn) Promise.resolve(fn()).catch((err) => say('Klarte ikke å angre (' + (err.code || err.message) + ').'));
});
for (const id of ['file-food', 'file-ex']) {
  $(id).addEventListener('change', () => prepareImport().catch((err) => { $('import-status').textContent = 'Klarte ikke å lese fila: ' + err.message; }));
}
$('import-run').addEventListener('click', runImport);
document.addEventListener('visibilitychange', () => {
  // Står appen åpen over midnatt, hopper «I dag» til den nye dagen.
  if (document.visibilityState === 'visible' && setup && followToday && !isToday(day)) goTo(new Date());
});

if (!configured) {
  say('Innloggingen er ikke satt opp: js/firebase-config.js mangler verdiene fra Firebase.');
} else {
  onUser(async (user) => {
    if (!user) {
      $('content').hidden = true;
      say('Appen er privat.', true);
      return;
    }
    say('Henter …');
    try {
      if (!(await loadSetup())) {
        say('Oppsettet mangler i Firestore. Kjør workflowen «Kalorier» med modus «oppsett» i builder-repoet.');
        return;
      }
      await ensureFrom(addDays(mondayOf(new Date()), -7 * WEEKS_STEP));
      say('');
      renderGrids();
      render();
    } catch (err) {
      say(err && err.code === 'permission-denied'
        ? 'Ingen tilgang. Er de nye reglene for matlogg og kalorioppsett limt inn i Firebase?'
        : 'Klarte ikke å lese data (' + (err.code || err.message) + ').');
    }
  });
}
