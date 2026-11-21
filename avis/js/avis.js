// Avisa: henter dagens utgave fra Firestore (avis/<dato>) og tegner den.
//
// Utgavene skrives av .github/workflows/avis.yml fra tools/avis/<dato>.json, som den nattlige
// jobben i vaulten lager. Ingenting om Vidar står her: seksjoner, saker og begrunnelser kommer
// fra utgaven selv. firestore.rules er det som stenger andre ute.
//
// Tommel opp / tommel ned: Vidar vurderer en sak, og vurderingen lagres i
// avislest/<dato>_<sak-id> (feltet vurdering: 1 eller -1). Samlingen het «lest» før tomlene kom
// og beholder navnet, så Firestore-reglene er de samme; eldre merker uten vurdering er bare «lest».
// Nattjobben eksporterer vurderingene og bruker dem til å justere hva avisa skriver om.
// En vurdert sak blir stående (dempet) til siden lastes på nytt, så ingenting hopper. Ved neste
// lasting er den borte. Uvurderte saker fra de siste sju dagene følger med i den nyeste utgaven,
// under «Fra tidligere dager». «Vis vurderte» henter fram igjen sakene som var vurdert da siden
// ble lastet, dempet og med tommelen trykket inn, så de kan åpnes eller vurderes på nytt.
// Et trykk på tommelen som alt er trykket inn, angrer vurderingen.
//
// Dagens stilling: utgaven kan ha én utlyst stilling i Stockholm (feltet stilling), vist i et eget
// kort under sakene med de samme tomlene. Den lagres i avislest som en sak med seksjon «stilling»,
// og følger ikke med til nye utgaver: hver utgave har sin egen.
//
// Lokal forhåndsvisning uten Firebase: start en server i repoets rot (python -m http.server)
// og åpne http://localhost:8000/avis/?fil=2026-11-17, som leser tools/avis/2026-11-17.json.
// &eldre=2026-11-16 legger til en eldre utgave. Vurderingene huskes da bare til siden lastes på nytt.
// Det virker bare på localhost, og tools/ publiseres ikke.

import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, configured, mountAuthBar, onUser, signIn, showError } from '/js/auth.js';

const $ = (id) => document.getElementById(id);
const DAG = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
const KORT = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' });
const KL = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
const DAGER_MED = 7; // så lenge en uvurdert sak følger med til nye utgaver

let alle = [];              // alle sakene i visningen, også de som var vurdert, se normaliser()
let saker = [];             // sakene som vises nå
let visLeste = false;       // «Vis vurderte» er trykket inn
let seksjon = 'alle';
let lagre = null;           // (sak, verdi) => Promise, verdi 1, -1 eller null; null i lokal forhåndsvisning
let vurdFor = new Map();    // nøkkel → 1, -1 eller 0 (gammelt «lest») da siden ble lastet: vises ikke
let vurdNa = new Map();     // vurderingene nå, også de som er gjort i denne visningen (vises dempet)
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

// Hver sak får dato, nøkkel og seksjonen fra sin egen utgave. Dagens stilling kommer bare fra
// utgaven som vises, ikke fra de eldre.
const STILLING = { id: 'stilling', navn: 'Dagens stilling', farge: 0 };
function normaliser(utgave, eldre) {
  const st = !eldre && utgave.stilling
    ? [{ ...utgave.stilling, dato: utgave.dato, nokkel: utgave.dato + '_' + utgave.stilling.id, eldre, stilling: true, sek: STILLING }]
    : [];
  return utgave.saker.map((s) => {
    const i = utgave.seksjoner.findIndex((x) => x.id === s.seksjon);
    const sx = utgave.seksjoner[i] || { id: s.seksjon, navn: s.seksjon };
    return {
      ...s, dato: utgave.dato, nokkel: utgave.dato + '_' + s.id, eldre,
      sek: { id: sx.id, navn: sx.navn, farge: sx.farge || (Math.max(i, 0) % 6) + 1 },
    };
  }).concat(st);
}

// ---------- Tegning ----------

function render(data, eldre = []) {
  seksjon = 'alle';
  visLeste = false;
  alle = [...normaliser(data, false), ...eldre.flatMap((u) => normaliser(u, true))];
  vurdNa = new Map(alle.filter((s) => vurdFor.has(s.nokkel)).map((s) => [s.nokkel, vurdFor.get(s.nokkel)]));
  velgSaker();
  $('dag-tittel').textContent = stor(DAG.format(somDato(data.dato)));
  $('ingress').textContent = data.ingress || '';
  $('updated').textContent = data.laget ? 'Laget kl. ' + KL.format(new Date(data.laget)) : '';
  tegnFilter();
  tegnSaker();
  $('notice').hidden = true;
  $('avis').hidden = false;
}

// Det som var vurdert da siden ble lastet, er skjult, med mindre «Vis vurderte» er trykket inn.
// En sak som får vurderingen angret mens de vises, blir stående når de skjules igjen.
const skjult = (s) => vurdFor.has(s.nokkel) && vurdNa.has(s.nokkel);
function velgSaker() {
  saker = alle.filter((s) => visLeste || !skjult(s));
}

function tegnLesteKnapp() {
  const n = alle.filter(skjult).length;
  const b = $('vis-leste');
  b.hidden = !n && !visLeste;
  b.setAttribute('aria-pressed', String(visLeste));
  b.textContent = visLeste ? 'Skjul vurderte' : `Vis vurderte (${n})`;
}

function tegnFilter() {
  const f = $('filter');
  f.replaceChildren();
  const valg = [{ id: 'alle', navn: 'Alle' }];
  for (const s of saker) if (!s.stilling && !valg.some((v) => v.id === s.sek.id)) valg.push(s.sek);
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
  if (sak.stilling) return stillingMeta(sak);
  const p = el('p', 'sak-meta sek-' + sak.sek.farge);
  if (medSeksjon) p.append(el('span', 'swatch'), el('span', 'sak-seksjon', sak.sek.navn));
  const k = sak.kilder[0];
  let kilde = k.navn.split(':')[0];
  if (sak.kilder.length > 1) kilde += ' + ' + (sak.kilder.length - 1);
  if (k.dato) kilde += ' · ' + KORT.format(somDato(k.dato));
  p.append(el('span', null, kilde));
  return p;
}

// Stillingen: arbeidsgiver, sted og søknadsfrist i stedet for seksjon og kilde.
function stillingMeta(st) {
  const p = el('p', 'sak-meta stilling-meta');
  p.append(el('span', 'sak-seksjon', st.arbeidsgiver), el('span', null, st.sted));
  if (st.frist) p.append(el('span', null, 'Frist ' + KORT.format(somDato(st.frist))));
  return p;
}

// Tommelen peker opp; tommel ned er samme tegning snudd i CSS-en.
const TOMMEL = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3z"/><path d="M7 10l4-7a2.5 2.5 0 0 1 3 2.6L13.5 9H19a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.7 21H7"/></svg>';
const TOMLER = [
  { verdi: 1, cls: 'opp', tekst: 'Mer av dette', title: 'Tommel opp: mer av dette. Saken er borte neste gang avisa lastes.' },
  { verdi: -1, cls: 'ned', tekst: 'Mindre av dette', title: 'Tommel ned: mindre av dette. Saken er borte neste gang avisa lastes.' },
];
const TOMLER_STILLING = [
  { verdi: 1, cls: 'opp', tekst: 'Bra forslag', title: 'Tommel opp: et bra forslag, flere som denne.' },
  { verdi: -1, cls: 'ned', tekst: 'Dårlig forslag', title: 'Tommel ned: ikke noe for meg, færre som denne.' },
];

// To knapper i en gruppe. data-nokkel sier hvilken sak de gjelder, så sett() finner dem alle.
function tommelKnapper(sak, stor) {
  const g = el('div', 'tomler');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', 'Vurder saken');
  for (const t of (sak || apen) && (sak || apen).stilling ? TOMLER_STILLING : TOMLER) {
    const b = el('button', 'btn tommel ' + t.cls + (stor ? ' stor' : ''));
    b.type = 'button';
    b.dataset.nokkel = sak ? sak.nokkel : '';
    b.dataset.verdi = String(t.verdi);
    b.title = t.title;
    b.setAttribute('aria-label', t.tekst);
    b.setAttribute('aria-pressed', String(!!sak && vurdNa.get(sak.nokkel) === t.verdi));
    b.innerHTML = TOMMEL + (stor ? '<span>' + t.tekst + '</span>' : '');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = sak || apen;
      if (s) vurder(s, t.verdi);
    });
    g.append(b);
  }
  return g;
}

function kort(sak, hoved) {
  const a = el('article', 'sak' + (hoved ? ' hoved' : '') + (sak.stilling ? ' stilling' : '') + (vurdNa.has(sak.nokkel) ? ' er-lest' : ''));
  a.dataset.nokkel = sak.nokkel;
  const h = el('h2', 'sak-tittel');
  const apne = el('button', 'sak-apne', sak.tittel);
  apne.type = 'button';
  apne.addEventListener('click', () => apneSak(sak));
  h.append(apne);
  const bunn = el('div', 'sak-bunn');
  bunn.append(tommelKnapper(sak, false));
  a.append(meta(sak, seksjon === 'alle'), h, el('p', 'sak-tekst', sak.sammendrag), bunn);
  return a;
}

function tegnSaker() {
  const st = seksjon === 'alle' ? saker.find((s) => s.stilling) : null;
  const synlig = saker.filter((s) => !s.stilling && (seksjon === 'alle' || s.sek.id === seksjon));
  const nye = synlig.filter((s) => !s.eldre);
  const gamle = synlig.filter((s) => s.eldre);
  const hoved = nye.find((s) => s.viktig);

  const box = $('saker');
  box.replaceChildren();
  for (const s of hoved ? [hoved, ...nye.filter((x) => x !== hoved)] : nye) box.append(kort(s, s === hoved));
  if (!nye.length) box.append(el('p', 'tom', saker.some((s) => !s.stilling) ? 'Ingen nye saker her i dag.' : 'Alt er vurdert.'));

  $('stilling').replaceChildren(...(st ? [kort(st, false)] : []));
  $('stilling-blokk').hidden = !st;

  const eb = $('eldre');
  eb.replaceChildren();
  for (const s of gamle) eb.append(kort(s, false));
  $('eldre-blokk').hidden = !gamle.length;
  tegnLesteKnapp();
}

// ---------- Vurdering ----------

// verdi: 1, -1, 0 (gammelt «lest») eller null (ikke vurdert).
function sett(nokkel, verdi) {
  if (verdi == null) vurdNa.delete(nokkel); else vurdNa.set(nokkel, verdi);
  for (const a of document.querySelectorAll('.sak')) {
    if (a.dataset.nokkel === nokkel) a.classList.toggle('er-lest', verdi != null);
  }
  for (const b of document.querySelectorAll('.tommel')) {
    if (b.dataset.nokkel === nokkel) b.setAttribute('aria-pressed', String(Number(b.dataset.verdi) === verdi));
  }
  tegnLesteKnapp();
}

// Samme tommel en gang til angrer; den andre tommelen bytter.
async function vurder(sak, verdi) {
  const for_ = vurdNa.has(sak.nokkel) ? vurdNa.get(sak.nokkel) : null;
  const ny = for_ === verdi ? null : verdi;
  sett(sak.nokkel, ny);
  if (!lagre) return;
  try {
    await lagre(sak, ny);
  } catch (err) {
    sett(sak.nokkel, for_);
    say('Klarte ikke å lagre vurderingen (' + (err && err.code ? err.code : 'ukjent feil') + ').');
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
  $('d-hvorfor-tittel').textContent = sak.stilling ? 'Hvorfor denne stillingen' : 'Hvorfor du får denne';
  $('d-kilder-tittel').textContent = sak.stilling ? 'Utlysningen' : 'Kilder';
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
  $('d-bunn').replaceChildren(tommelKnapper(sak, true));
  $('dialog').showModal();
}

$('lukk').addEventListener('click', () => $('dialog').close());
$('vis-leste').addEventListener('click', () => {
  visLeste = !visLeste;
  velgSaker();
  tegnFilter();
  tegnSaker();
});
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
  lagre = (sak, verdi) => (verdi
    ? setDoc(doc(db, 'avislest', sak.nokkel), {
      dato: sak.dato, sak: sak.id, tittel: sak.tittel, seksjon: sak.sek.id,
      vurdering: verdi, lest: new Date().toISOString(),
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
      // Bare den nyeste utgaven tar med uvurderte saker fra dagene før.
      let eldre = [];
      if (!neste) {
        const r = await getDocs(query(avis, where('dato', '>=', fra), where('dato', '<', data.dato), orderBy('dato', 'desc')));
        eldre = r.docs.map((d) => JSON.parse(d.data().json));
      }
      vurdFor = new Map(lest.docs.map((d) => [d.id, d.data().vurdering || 0]));
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
