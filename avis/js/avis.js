// Avisa: henter dagens utgave fra Firestore (avis/<dato>) og tegner den.
//
// Utgavene skrives av .github/workflows/avis.yml fra tools/avis/<dato>.json, som den nattlige
// jobben i vaulten lager. Ingenting om Vidar står her: seksjoner, saker og begrunnelser kommer
// fra utgaven selv. firestore.rules er det som stenger andre ute.
//
// «Lest»: Vidar merker en sak som lest, og den lagres i avislest/<dato>_<sak-id>. Saken blir
// stående (dempet) til siden lastes på nytt, så ingenting hopper. Ved neste lasting er den borte.
// Uleste saker fra de siste sju dagene følger med i den nyeste utgaven, under «Fra tidligere dager».
//
// Lokal forhåndsvisning uten Firebase: start en server i repoets rot (python -m http.server)
// og åpne http://localhost:8000/avis/?fil=2026-11-17, som leser tools/avis/2026-11-17.json.
// &eldre=2026-11-16 legger til en eldre utgave. «Lest» huskes da bare til siden lastes på nytt.
// Det virker bare på localhost, og tools/ publiseres ikke.

import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, configured, mountAuthBar, onUser, signIn, showError } from '/js/auth.js';

const $ = (id) => document.getElementById(id);
const DAG = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
const KORT = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' });
const KL = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
const DAGER_MED = 7; // så lenge en ulest sak følger med til nye utgaver

let saker = [];             // sakene i visningen, se normaliser()
let seksjon = 'alle';
let lagre = null;           // (sak, lest) => Promise; null i lokal forhåndsvisning
let lestFor = new Set();    // lest da siden ble lastet: vises ikke
let lestNa = new Set();     // merket i denne visningen: vises, men dempet
let apen = null;            // saken som er åpen i dialogen

// ---------- Hjelpere ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const somDato = (iso) => new Date(iso + 'T12:00:00');
const stor = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function dagerFor(iso, n) {
  const d = somDato(iso);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function say(text, withLogin) {
  const n = $('notice');
  n.textContent = text;
  if (withLogin) {
    const b = el('button', 'btn', 'Logg inn med Google');
    b.type = 'button';
    b.addEventListener('click', () => signIn().catch(showError));
    n.append(b);
  }
  n.hidden = false;
}

// Hver sak får dato, nøkkel og seksjonen fra sin egen utgave.
function normaliser(utgave, eldre) {
  return utgave.saker.map((s) => {
    const i = utgave.seksjoner.findIndex((x) => x.id === s.seksjon);
    const sx = utgave.seksjoner[i] || { id: s.seksjon, navn: s.seksjon };
    return {
      ...s, dato: utgave.dato, nokkel: utgave.dato + '_' + s.id, eldre,
      sek: { id: sx.id, navn: sx.navn, farge: sx.farge || (Math.max(i, 0) % 6) + 1 },
    };
  });
}

// ---------- Tegning ----------

function render(data, eldre = []) {
  lestNa = new Set();
  seksjon = 'alle';
  saker = [...normaliser(data, false), ...eldre.flatMap((u) => normaliser(u, true))]
    .filter((s) => !lestFor.has(s.nokkel));
  $('dag-tittel').textContent = stor(DAG.format(somDato(data.dato)));
  $('ingress').textContent = data.ingress || '';
  $('updated').textContent = data.laget ? 'Laget kl. ' + KL.format(new Date(data.laget)) : '';
  tegnFilter();
  tegnSaker();
  $('notice').hidden = true;
  $('avis').hidden = false;
}

function tegnFilter() {
  const f = $('filter');
  f.replaceChildren();
  const valg = [{ id: 'alle', navn: 'Alle' }];
  for (const s of saker) if (!valg.some((v) => v.id === s.sek.id)) valg.push(s.sek);
  f.hidden = valg.length <= 2; // én seksjon: ingenting å velge mellom
  for (const v of valg) {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v.id === seksjon));
    if (v.id !== 'alle') {
      b.className = 'sek-' + v.farge;
      b.append(el('span', 'swatch'));
    }
    b.append(document.createTextNode(v.navn));
    b.addEventListener('click', () => {
      seksjon = v.id;
      for (const x of f.children) x.setAttribute('aria-checked', String(x === b));
      tegnSaker();
    });
    f.append(b);
  }
}

function meta(sak, medSeksjon) {
  const p = el('p', 'sak-meta sek-' + sak.sek.farge);
  if (medSeksjon) p.append(el('span', 'swatch'), el('span', 'sak-seksjon', sak.sek.navn));
  const k = sak.kilder[0];
  let kilde = k.navn.split(':')[0];
  if (sak.kilder.length > 1) kilde += ' + ' + (sak.kilder.length - 1);
  if (k.dato) kilde += ' · ' + KORT.format(somDato(k.dato));
  p.append(el('span', null, kilde));
  return p;
}

const SIRKEL = '<svg class="ikon-ulest" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/></svg>';
const SJEKK = '<svg class="ikon-lest" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>';

function lestKnapp(cls) {
  const b = el('button', 'btn lest-btn ' + (cls || ''));
  b.type = 'button';
  b.innerHTML = SIRKEL + SJEKK + '<span>Lest</span>';
  b.title = 'Merk som lest. Saken er borte neste gang avisa lastes.';
  return b;
}

function kort(sak, hoved) {
  const a = el('article', 'sak' + (hoved ? ' hoved' : '') + (lestNa.has(sak.nokkel) ? ' er-lest' : ''));
  a.dataset.nokkel = sak.nokkel;
  const h = el('h2', 'sak-tittel');
  const apne = el('button', 'sak-apne', sak.tittel);
  apne.type = 'button';
  apne.addEventListener('click', () => apneSak(sak));
  h.append(apne);
  const bunn = el('div', 'sak-bunn');
  const lest = lestKnapp();
  lest.dataset.lest = sak.nokkel;
  lest.setAttribute('aria-pressed', String(lestNa.has(sak.nokkel)));
  lest.addEventListener('click', () => vend(sak));
  bunn.append(lest);
  a.append(meta(sak, seksjon === 'alle'), h, el('p', 'sak-tekst', sak.sammendrag), bunn);
  return a;
}

function tegnSaker() {
  const synlig = saker.filter((s) => seksjon === 'alle' || s.sek.id === seksjon);
  const nye = synlig.filter((s) => !s.eldre);
  const gamle = synlig.filter((s) => s.eldre);
  const hoved = nye.find((s) => s.viktig);

  const box = $('saker');
  box.replaceChildren();
  for (const s of hoved ? [hoved, ...nye.filter((x) => x !== hoved)] : nye) box.append(kort(s, s === hoved));
  if (!nye.length) box.append(el('p', 'tom', saker.length ? 'Ingen nye saker her i dag.' : 'Alt er lest.'));

  const eb = $('eldre');
  eb.replaceChildren();
  for (const s of gamle) eb.append(kort(s, false));
  $('eldre-blokk').hidden = !gamle.length;
}

// ---------- Lest ----------

function sett(nokkel, lest) {
  if (lest) lestNa.add(nokkel); else lestNa.delete(nokkel);
  for (const a of document.querySelectorAll('.sak')) {
    if (a.dataset.nokkel === nokkel) a.classList.toggle('er-lest', lest);
  }
  for (const b of document.querySelectorAll('.lest-btn')) {
    if (b.dataset.lest === nokkel) b.setAttribute('aria-pressed', String(lest));
  }
}

async function vend(sak) {
  const lest = !lestNa.has(sak.nokkel);
  sett(sak.nokkel, lest);
  if (!lagre) return;
  try {
    await lagre(sak, lest);
  } catch (err) {
    sett(sak.nokkel, !lest);
    say('Klarte ikke å lagre at saken er lest (' + (err && err.code ? err.code : 'ukjent feil') + ').');
  }
}

// ---------- Dialogen med hele saken ----------

function apneSak(sak) {
  apen = sak;
  $('d-meta').replaceWith(Object.assign(meta(sak, true), { id: 'd-meta' }));
  $('d-tittel').textContent = sak.tittel;
  const t = $('d-tekst');
  t.replaceChildren(el('p', null, sak.sammendrag));
  for (const avsnitt of (sak.mer || '').split(/\n\s*\n/).filter(Boolean)) t.append(el('p', null, avsnitt));
  $('d-hvorfor').textContent = sak.hvorfor;
  const ul = $('d-kilder');
  ul.replaceChildren();
  for (const k of sak.kilder) {
    const li = el('li');
    const a = el('a', null, k.navn);
    a.href = k.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a);
    if (k.dato) li.append(el('span', 'kilde-dato', KORT.format(somDato(k.dato))));
    ul.append(li);
  }
  $('d-lest').dataset.lest = sak.nokkel;
  $('d-lest').setAttribute('aria-pressed', String(lestNa.has(sak.nokkel)));
  $('dialog').showModal();
}

{
  const b = lestKnapp('btn-primary');
  b.id = 'd-lest';
  b.addEventListener('click', () => { if (apen) vend(apen); });
  $('d-bunn').append(b);
}
$('lukk').addEventListener('click', () => $('dialog').close());
$('dialog').addEventListener('click', (e) => { if (e.target === $('dialog')) $('dialog').close(); });

// ---------- Henting ----------

function settNav(forrige, neste) {
  for (const [id, dato] of [['forrige', forrige], ['neste', neste]]) {
    $(id).disabled = !dato;
    $(id).dataset.dato = dato || '';
  }
}
for (const id of ['forrige', 'neste']) {
  $(id).addEventListener('click', () => { if ($(id).dataset.dato) location.hash = $(id).dataset.dato; });
}

const params = new URLSearchParams(location.search);
const lokal = ['localhost', '127.0.0.1'].includes(location.hostname) && params.get('fil');

mountAuthBar($('auth'));

if (lokal) {
  const hent = (f) => fetch('/tools/avis/' + f + '.json').then((r) => r.json());
  Promise.all([hent(lokal), ...params.getAll('eldre').map(hent)])
    .then(([data, ...eldre]) => { render(data, eldre); settNav(null, null); })
    .catch(() => say('Fant ikke tools/avis/' + lokal + '.json.'));
} else if (!configured) {
  say('Innloggingen er ikke satt opp ennå: js/firebase-config.js mangler verdiene fra Firebase-prosjektet.');
} else {
  const db = getFirestore(app);
  const avis = collection(db, 'avis');
  lagre = (sak, lest) => (lest
    ? setDoc(doc(db, 'avislest', sak.nokkel), {
      dato: sak.dato, sak: sak.id, tittel: sak.tittel, lest: new Date().toISOString(),
    })
    : deleteDoc(doc(db, 'avislest', sak.nokkel)));

  const nabo = async (dato, op) => {
    const q = query(avis, where('dato', op, dato), orderBy('dato', op === '<' ? 'desc' : 'asc'), limit(1));
    const r = await getDocs(q);
    return r.empty ? null : r.docs[0].id;
  };

  const vis = async () => {
    const dato = /^#\d{4}-\d{2}-\d{2}$/.test(location.hash) ? location.hash.slice(1) : null;
    say('Henter avisa …');
    try {
      let snap;
      if (dato) {
        snap = await getDoc(doc(db, 'avis', dato));
      } else {
        const r = await getDocs(query(avis, orderBy('dato', 'desc'), limit(1)));
        snap = r.docs[0];
      }
      if (!snap || !snap.exists()) {
        $('avis').hidden = true;
        say(dato ? 'Det finnes ingen avis for ' + DAG.format(somDato(dato)) + '.' : 'Ingen utgaver ennå. Avisa lages hver natt.');
        return;
      }
      const data = JSON.parse(snap.data().json);
      const fra = dagerFor(data.dato, DAGER_MED);
      const [forrige, neste, lest] = await Promise.all([
        nabo(data.dato, '<'),
        nabo(data.dato, '>'),
        getDocs(query(collection(db, 'avislest'), where('dato', '>=', dagerFor(fra, 1)))),
      ]);
      // Bare den nyeste utgaven tar med uleste saker fra dagene før.
      let eldre = [];
      if (!neste) {
        const r = await getDocs(query(avis, where('dato', '>=', fra), where('dato', '<', data.dato), orderBy('dato', 'desc')));
        eldre = r.docs.map((d) => JSON.parse(d.data().json));
      }
      lestFor = new Set(lest.docs.map((d) => d.id));
      render(data, eldre);
      settNav(forrige, neste);
    } catch (err) {
      $('avis').hidden = true;
      say(err && err.code === 'permission-denied'
        ? 'Denne kontoen har ikke tilgang.'
        : 'Klarte ikke å hente avisa (' + (err && err.code ? err.code : 'ukjent feil') + ').');
    }
  };

  let innlogget = false;
  onUser((user) => {
    innlogget = !!user;
    if (!user) {
      $('avis').hidden = true;
      $('updated').textContent = '';
      say('Avisa er privat.', true);
      return;
    }
    vis();
  });
  window.addEventListener('hashchange', () => { if (innlogget) vis(); });
}
