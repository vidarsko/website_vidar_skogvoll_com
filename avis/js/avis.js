// Avisa: henter dagens utgave fra Firestore (avis/<dato>) og tegner den.
//
// Utgavene skrives av .github/workflows/avis.yml fra tools/avis/<dato>.json, som den nattlige
// jobben i vaulten lager. Ingenting om Vidar står her: seksjoner, saker og begrunnelser kommer
// fra utgaven selv. firestore.rules er det som stenger andre ute.
//
// Lokal forhåndsvisning uten Firebase: start en server i repoets rot (python -m http.server)
// og åpne http://localhost:8000/avis/?fil=2026-11-17, som leser tools/avis/2026-11-17.json.
// Det virker bare på localhost, og tools/ publiseres ikke.

import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, configured, mountAuthBar, onUser, signIn, showError } from '/js/auth.js';

const $ = (id) => document.getElementById(id);
const DAG = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
const KORT = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' });
const KL = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });

let utgave = null;
let seksjon = 'alle';

// ---------- Hjelpere ----------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const somDato = (iso) => new Date(iso + 'T12:00:00');
const stor = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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

// ---------- Tegning ----------

function render(data) {
  utgave = data;
  seksjon = 'alle';
  $('dag-tittel').textContent = stor(DAG.format(somDato(data.dato)));
  $('ingress').textContent = data.ingress || '';
  $('updated').textContent = data.laget ? 'Laget kl. ' + KL.format(new Date(data.laget)) : '';
  tegnFilter();
  tegnSaker();
  $('notice').hidden = true;
  $('avis').hidden = false;
}

function seksjonAv(id) {
  const i = utgave.seksjoner.findIndex((s) => s.id === id);
  const s = utgave.seksjoner[i];
  return { navn: s ? s.navn : id, farge: s && s.farge ? s.farge : (i % 6) + 1 };
}

function tegnFilter() {
  const f = $('filter');
  f.replaceChildren();
  const brukt = new Set(utgave.saker.map((s) => s.seksjon));
  const valg = [{ id: 'alle', navn: 'Alle' }, ...utgave.seksjoner.filter((s) => brukt.has(s.id))];
  f.hidden = valg.length <= 2; // én seksjon: ingenting å velge mellom
  for (const v of valg) {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v.id === seksjon));
    if (v.id !== 'alle') {
      b.className = 'sek-' + seksjonAv(v.id).farge;
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
  const p = el('p', 'sak-meta sek-' + seksjonAv(sak.seksjon).farge);
  if (medSeksjon) {
    p.append(el('span', 'swatch'), el('span', 'sak-seksjon', seksjonAv(sak.seksjon).navn));
  }
  const k = sak.kilder[0];
  let kilde = k.navn.split(':')[0];
  if (sak.kilder.length > 1) kilde += ' + ' + (sak.kilder.length - 1);
  if (k.dato) kilde += ' · ' + KORT.format(somDato(k.dato));
  p.append(el('span', null, kilde));
  return p;
}

function tegnSaker() {
  const box = $('saker');
  box.replaceChildren();
  const saker = utgave.saker.filter((s) => seksjon === 'alle' || s.seksjon === seksjon);
  const hoved = saker.find((s) => s.viktig);
  for (const sak of hoved ? [hoved, ...saker.filter((s) => s !== hoved)] : saker) {
    const a = el('article', 'sak' + (sak === hoved ? ' hoved' : ''));
    const h = el('h2', 'sak-tittel');
    const b = el('button', 'sak-apne', sak.tittel);
    b.type = 'button';
    b.addEventListener('click', () => apne(sak));
    h.append(b);
    a.append(meta(sak, seksjon === 'alle'), h, el('p', 'sak-tekst', sak.sammendrag));
    box.append(a);
  }
}

// ---------- Dialogen med hele saken ----------

function apne(sak) {
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
  $('dialog').showModal();
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

const lokal = ['localhost', '127.0.0.1'].includes(location.hostname)
  && new URLSearchParams(location.search).get('fil');

mountAuthBar($('auth'));

if (lokal) {
  fetch('/tools/avis/' + lokal + '.json')
    .then((r) => r.json())
    .then((data) => { render(data); settNav(null, null); })
    .catch(() => say('Fant ikke tools/avis/' + lokal + '.json.'));
} else if (!configured) {
  say('Innloggingen er ikke satt opp ennå: js/firebase-config.js mangler verdiene fra Firebase-prosjektet.');
} else {
  const db = getFirestore(app);
  const avis = collection(db, 'avis');

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
      render(data);
      settNav(...await Promise.all([nabo(data.dato, '<'), nabo(data.dato, '>')]));
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
