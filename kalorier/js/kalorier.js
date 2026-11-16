// Kaloriappen: rask logging av mat og trening, med dagsbudsjett.
//
// Alt innhold kommer fra Firestore etter innlogging. Oppsettet (kategorier, omregninger,
// ikoner, budsjett og reglene for Lose It-importen) ligger i dokumentet kalorioppsett/oppsett,
// ikke her: denne fila er offentlig, og skal ikke si noe om hva Vidar spiser. Oppsettet skrives
// fra tools/kalorier_oppsett.json av workflowen kalorier.yml.
//
// Matloggen ligger i samlingen «matlogg», én oppføring per dokument:
//   t (tid), kat (kategori-id), kcal (+ mat, − trening, netto),
//   notat (valgfritt; Lose It-navnet på importerte rader), kilde ('app' | 'loseit'), lagret.
// Lose It-historikken ble importert én gang 2026-11-16; importen ble fjernet etterpå (se git-historikken).
// Se kalorier_private/AGENTS.md.

import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, deleteDoc,
  query, where, orderBy, Timestamp, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, configured, mountAuthBar, onUser, signIn, showError } from '/js/auth.js';

const $ = (id) => document.getElementById(id);
const db = configured ? getFirestore(app) : null;
const LOG = 'matlogg';
const WEEKS_STEP = 10;

let setup = null;
const cats = new Map();
let entries = []; // { id, t: Date, kat, kcal, notat, kilde }
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
// Bare kcal lagres. Mengden regnes ut fra kcal og omregningen i oppsettet når den vises, så en
// endret omregning aldri krever at gamle oppføringer skrives om (kcal står fast).
function amountOf(cat, kcal) {
  return Math.round((Math.abs(kcal) / cat.kcal) * 100) / 100;
}
function kcalOf(cat, m) {
  const k = Math.round(m * cat.kcal);
  return cat.type === 'trening' ? -k : k;
}
// Fargen kommer fra kategoriens gruppe (frokost, drikke, sott, frukt, maltid, trening, annet).
const groupClass = (cat) => 'g-' + ((cat && cat.gruppe) || 'annet');

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
  return { id: d.id, t: x.t.toDate(), kat: x.kat, kcal: x.kcal, notat: x.notat || '', kilde: x.kilde || '' };
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
    const icon = document.createElement('span'); icon.className = 'e-icon ' + groupClass(cat); icon.append(iconSvg(cat, 24));
    const name = document.createElement('span'); name.className = 'e-name';
    name.textContent = cat ? cat.navn : e.kat;
    const sub = document.createElement('small');
    sub.textContent = [cat ? amountText(cat, amountOf(cat, e.kcal)) : '', e.notat].filter(Boolean).join(' · ');
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
      b.type = 'button'; b.className = 'cat ' + groupClass(cat);
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
  $('entry').className = 'entry-dialog ' + groupClass(cat);
  $('entry-icon').replaceChildren(iconSvg(cat, 32));
  $('entry-title').textContent = cat.navn;
  $('entry-info').textContent = cat.info || '';
  $('entry-info').hidden = !cat.info;
  $('entry-conv').textContent = cat.enhet === 'kcal'
    ? 'Antall kcal, omtrent'
    : `1 ${cat.enhet}${cat.str ? ' (' + cat.str + ')' : ''} = ${fmtNum(cat.kcal)} kcal${cat.type === 'trening' ? ' netto' : ''}`;

  const r = $('entry-range');
  const value = entry ? amountOf(cat, entry.kcal) : cat.std;
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
  const data = {
    t: Timestamp.fromDate(t),
    kat: current.id,
    kcal: kcalLocked != null ? kcalLocked : kcalOf(current, Number($('entry-range').value)),
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
    const saved = { id, t, kat: data.kat, kcal: data.kcal, notat: data.notat, kilde: data.kilde };
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
    t: Timestamp.fromDate(entry.t), kat: entry.kat, kcal: entry.kcal,
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
