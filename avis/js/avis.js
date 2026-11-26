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
// Tilbakemelding med ord: knappen «Tilbakemelding» på hvert kort, i dialogen med hele saken og
// nederst i utgaven åpner en popup med et tekstfelt. Teksten lagres i samme dokument som
// tommelen (feltet kommentar); utgavens i avislest/<dato>__utgave. En kommentar alene skjuler ikke
// saken: bare en tommel gjør det. Nattjobben leser tomler og kommentarer som små hint, se skillen.
//
// Legg til i vaulten og Lag oppgave: to knapper på hvert kort og i dialogen (ikke på hele utgaven)
// åpner den samme popupen. «Legg til i vaulten» lagrer Vidars forklaring på hvordan saken skal inn
// (feltet vault), «Lag oppgave» ber om en oppgave i vaultens Tasks/ (feltet oppgave, teksten er
// valgfri og kan være tom). Begge ligger i samme avislest-dokument som tommelen, skjuler ikke
// saken, og utføres av nattjobben, som leser dem fra eksporten. «Fjern» i popupen trekker ønsket.
//
// Dagens stilling: utgaven kan ha én utlyst stilling i Stockholm (feltet stilling), vist i et eget
// kort under sakene med de samme tomlene. Den lagres i avislest som en sak med seksjon «stilling»,
// og følger ikke med til nye utgaver: hver utgave har sin egen.
//
// Lokal forhåndsvisning uten Firebase: start en server i repoets rot (python -m http.server)
// og åpne http://localhost:8000/avis/?fil=2026-11-17, som leser tools/avis/2026-11-17.json.
// &eldre=2026-11-16 legger til en eldre utgave, og &vurdert=<dato>_<sak-id> later som en sak var
// vurdert da siden ble lastet. Vurderingene huskes da bare til siden lastes på nytt.
// Det virker bare på localhost, og tools/ publiseres ikke.

import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, query, where, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, configured, mountAuthBar, onUser, signIn, showError } from '/js/auth.js';

const $ = (id) => document.getElementById(id);
const DAG = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
const KORT = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' });
const KL = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
const ISO_OSLO = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }); // gir YYYY-MM-DD
const iDag = () => ISO_OSLO.format(new Date());
const DAGER_MED = 7; // så lenge en uvurdert sak følger med til nye utgaver

let alle = [];              // alle sakene i visningen, også de som var vurdert, se normaliser()
let saker = [];             // sakene som vises nå
let visLeste = false;       // «Vis vurderte» er trykket inn
let seksjon = 'alle';
let lagre = null;           // (sak) => Promise som skriver tommel og kommentar; null i lokal forhåndsvisning
let vurdFor = new Map();    // nøkkel → 1, -1 eller 0 (gammelt «lest») da siden ble lastet: vises ikke
let komm = new Map();       // nøkkel → kommentaren slik den er lagret
let vault = new Map();      // nøkkel → forklaringen på hvordan saken skal inn i vaulten
let oppg = new Map();       // nøkkel → merknad til oppgaven ('' er lov: bare «lag en oppgave»)
let utgaveDato = null;      // utgaven som vises, for kommentaren til hele utgaven
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
  utgaveDato = data.dato;
  $('u-tb').dataset.nokkel = data.dato + '__utgave';
  $('u-tb').setAttribute('aria-pressed', String(!!komm.get(data.dato + '__utgave')));
  velgSaker();
  $('dag-tittel').textContent = stor(DAG.format(somDato(data.dato)));
  $('ingress').textContent = data.ingress || '';
  $('idag').hidden = data.dato === iDag();
  $('updated').textContent = data.laget ? 'Laget kl. ' + KL.format(new Date(data.laget)) : '';
  tegnFilter();
  tegnSaker();
  $('notice').hidden = true;
  $('avis').hidden = false;
}

// Det som var vurdert da siden ble lastet, er skjult. «Vis vurderte» viser de vurderte sakene fra
// utgaven som vises (ikke fra dagene før) i en egen blokk under knappen. En sak som får
// vurderingen angret der, blir stående til knappen trykkes igjen.
const skjult = (s) => vurdFor.has(s.nokkel) && vurdNa.has(s.nokkel);
let vurderte = [];          // skjulte saker fra utgaven som vises
function velgSaker() {
  saker = alle.filter((s) => !skjult(s));
  vurderte = alle.filter((s) => skjult(s) && !s.eldre);
}

function tegnLesteKnapp() {
  const n = vurderte.length;
  const b = $('vis-leste');
  b.hidden = !n && !visLeste;
  b.setAttribute('aria-pressed', String(visLeste));
  b.textContent = visLeste ? 'Skjul vurderte' : `Vis vurderte (${n})`;
}

function tegnFilter() {
  const f = $('filter');
  f.replaceChildren();
  const valg = [{ id: 'alle', navn: 'Alle' }];
  for (const s of visLeste ? [...saker, ...vurderte] : saker) if (!s.stilling && !valg.some((v) => v.id === s.sek.id)) valg.push(s.sek);
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
  bunn.append(tbKnapp(sak), onskeKnapper(sak, false), tommelKnapper(sak, false));
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

  const vb = $('vurderte');
  vb.replaceChildren();
  if (visLeste) {
    for (const s of vurderte.filter((x) => seksjon === 'alle' || x.sek.id === seksjon)) vb.append(kort(s, false));
  }
  vb.hidden = !visLeste;
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
    await lagre(sak);
  } catch (err) {
    sett(sak.nokkel, for_);
    say('Klarte ikke å lagre vurderingen (' + (err && err.code ? err.code : 'ukjent feil') + ').');
  }
}

// ---------- Tilbakemelding med ord ----------

// De tre tingene popupen kan skrive. map er der teksten holdes; tom: om tom tekst er et gyldig ønske.
const MODUS = {
  kommentar: {
    map: () => komm, tittel: 'Tilbakemelding', tom: false, cls: 'tb-knapp',
    hint: 'F.eks. godt tema, men dårlig skrevet',
  },
  vault: {
    map: () => vault, tittel: 'Legg til i vaulten', tom: false, cls: 'vault-knapp',
    hint: 'Hvordan skal den inn? F.eks. som kilde i Sources, en linje i prosjektet Lære med KI, eller et sitat i foredraget om …',
    forklaring: 'Nattjobben legger den inn slik du skriver, og sier fra i rapporten.',
  },
  oppgave: {
    map: () => oppg, tittel: 'Lag oppgave', tom: true, cls: 'oppg-knapp',
    hint: 'Valgfritt: hva oppgaven er, frist, prosjekt …',
    forklaring: 'Nattjobben lager en oppgave i Tasks/. Du kan la feltet stå tomt.',
  },
};

// Knappen «Tilbakemelding». aria-pressed viser at det finnes en lagret tilbakemelding.
function tbKnapp(sak) {
  const b = el('button', 'btn tb-knapp', 'Tilbakemelding');
  b.type = 'button';
  b.dataset.nokkel = sak.nokkel;
  b.title = 'Skriv hva du synes om saken';
  b.setAttribute('aria-pressed', String(!!komm.get(sak.nokkel)));
  b.addEventListener('click', (e) => { e.stopPropagation(); apneTb(sak, 'kommentar'); });
  return b;
}

// «Legg til i vaulten» og «Lag oppgave». På kortet bare ikonet, i dialogen med tekst.
const IKON = {
  vault: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/><path d="M12 7v6M9 10h6"/></svg>',
  oppgave: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/></svg>',
};
function onskeKnapper(sak, stor) {
  const g = el('div', 'onsker');
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', 'Til vaulten');
  for (const modus of ['vault', 'oppgave']) {
    const m = MODUS[modus];
    const b = el('button', 'btn onske ' + m.cls + (stor ? ' stor' : ''));
    b.type = 'button';
    b.dataset.nokkel = sak.nokkel;
    b.title = m.tittel;
    b.setAttribute('aria-label', m.tittel);
    b.setAttribute('aria-pressed', String(m.map().has(sak.nokkel)));
    b.innerHTML = IKON[modus] + (stor ? '<span>' + m.tittel + '</span>' : '');
    b.addEventListener('click', (e) => { e.stopPropagation(); apneTb(sak, modus); });
    g.append(b);
  }
  return g;
}

let tbSak = null;   // saken popupen gjelder
let tbModus = 'kommentar';
function apneTb(sak, modus) {
  const m = MODUS[modus];
  tbSak = sak;
  tbModus = modus;
  $('tb-tittel').textContent = m.tittel;
  $('tb-om').textContent = sak.id === '__utgave' ? 'Om hele avisa ' + DAG.format(somDato(sak.dato)) + '.' : sak.tittel;
  $('tb-forklaring').textContent = m.forklaring || '';
  $('tb-forklaring').hidden = !m.forklaring;
  $('tb-label').textContent = m.tittel;
  $('tb-tekst').placeholder = m.hint;
  $('tb-tekst').value = m.map().get(sak.nokkel) || '';
  $('tb-fjern').hidden = modus === 'kommentar' || !m.map().has(sak.nokkel);
  $('tb-status').textContent = '';
  $('tb').showModal();
  $('tb-tekst').focus();
}

function oppdaterKnapper(nokkel, modus) {
  const m = MODUS[modus];
  for (const b of document.querySelectorAll('.' + m.cls)) {
    if (b.dataset.nokkel === nokkel) b.setAttribute('aria-pressed', String(m.map().has(nokkel) && (m.tom || !!m.map().get(nokkel))));
  }
}

// fjern: trekk ønsket (vault, oppgave). Ellers lagres teksten; tom tekst fjerner en kommentar eller
// en vault-forklaring, men er en gyldig oppgave.
async function lagreTb(fjern) {
  const sak = tbSak;
  const modus = tbModus;
  if (!sak) return;
  const m = MODUS[modus];
  const map = m.map();
  const hadde = map.has(sak.nokkel);
  const for_ = map.get(sak.nokkel);
  const tekst = $('tb-tekst').value.trim();
  if (!fjern && !tekst && !m.tom && modus !== 'kommentar') {
    $('tb-status').textContent = 'Skriv hvordan den skal legges til';
    $('tb-tekst').focus();
    return;
  }
  const beholdes = !fjern && (tekst || m.tom);
  if (beholdes && hadde && tekst === for_) { $('tb').close(); return; }
  if (!beholdes && !hadde) { $('tb').close(); return; }
  if (beholdes) map.set(sak.nokkel, tekst); else map.delete(sak.nokkel);
  $('tb-status').textContent = 'Lagrer …';
  try {
    if (lagre) await lagre(sak);
    oppdaterKnapper(sak.nokkel, modus);
    $('tb').close();
  } catch (err) {
    if (hadde) map.set(sak.nokkel, for_); else map.delete(sak.nokkel);
    $('tb-status').textContent = 'Klarte ikke å lagre (' + (err && err.code ? err.code : 'ukjent feil') + ')';
  }
}

// Hele utgaven lagres som en «sak» med id __utgave.
const utgaveSak = () => ({ id: '__utgave', dato: utgaveDato, nokkel: utgaveDato + '__utgave', tittel: 'Hele utgaven', sek: { id: 'utgave' } });
$('u-tb').addEventListener('click', () => apneTb(utgaveSak(), 'kommentar'));
$('tb-lagre').addEventListener('click', () => lagreTb(false));
$('tb-fjern').addEventListener('click', () => lagreTb(true));
$('tb-avbryt').addEventListener('click', () => $('tb').close());
$('tb-lukk').addEventListener('click', () => $('tb').close());
$('tb').addEventListener('click', (e) => { if (e.target === $('tb')) $('tb').close(); });
$('tb-tekst').addEventListener('input', () => { $('tb-status').textContent = ''; });

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
  $('d-bunn').replaceChildren(tbKnapp(sak), onskeKnapper(sak, true), tommelKnapper(sak, true));
  $('dialog').showModal();
}

$('lukk').addEventListener('click', () => $('dialog').close());
$('vis-leste').addEventListener('click', () => {
  visLeste = !visLeste;
  if (!visLeste) velgSaker(); // det som er angret i blokken, flytter opp til sakene
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
$('idag').addEventListener('click', () => { location.hash = iDag(); });
for (const id of ['forrige', 'neste']) {
  $(id).addEventListener('click', () => { if ($(id).dataset.dato) location.hash = $(id).dataset.dato; });
}

const params = new URLSearchParams(location.search);
const lokal = ['localhost', '127.0.0.1'].includes(location.hostname) && params.get('fil');

mountAuthBar($('auth'));

if (lokal) {
  const hent = (f) => fetch('/tools/avis/' + f + '.json').then((r) => r.json());
  Promise.all([hent(lokal), ...params.getAll('eldre').map(hent)])
    .then(([data, ...eldre]) => {
      vurdFor = new Map(params.getAll('vurdert').map((k) => [k, 1])); // &vurdert=<dato>_<sak-id>
      render(data, eldre);
      settNav(null, null);
    })
    .catch(() => say('Fant ikke tools/avis/' + lokal + '.json.'));
} else if (!configured) {
  say('Innloggingen er ikke satt opp ennå: js/firebase-config.js mangler verdiene fra Firebase-prosjektet.');
} else {
  const db = getFirestore(app);
  const avis = collection(db, 'avis');
  // Skriver hele tilstanden til saken: tommel (også 0 for gamle «lest»), kommentar, vault-forklaring
  // og oppgave. Uten noen av delene slettes dokumentet.
  lagre = (sak) => {
    const ref = doc(db, 'avislest', sak.nokkel);
    const verdi = vurdNa.has(sak.nokkel) ? vurdNa.get(sak.nokkel) : null;
    const tekst = komm.get(sak.nokkel) || '';
    const harVault = vault.has(sak.nokkel);
    const harOppg = oppg.has(sak.nokkel);
    if (verdi == null && !tekst && !harVault && !harOppg) return deleteDoc(ref);
    const d = {
      dato: sak.dato, sak: sak.id, tittel: sak.tittel, seksjon: sak.sek.id, lest: new Date().toISOString(),
    };
    if (verdi != null) d.vurdering = verdi;
    if (tekst) d.kommentar = tekst;
    if (harVault) d.vault = vault.get(sak.nokkel);
    if (harOppg) d.oppgave = oppg.get(sak.nokkel);
    return setDoc(ref, d);
  };

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
        say(dato ? 'Det finnes ingen avis for ' + DAG.format(somDato(dato)) + (dato === iDag() ? ' ennå.' : '.') : 'Ingen utgaver ennå. Avisa lages hver natt.');
        if (dato) { // ellers står man fast: pilene er skjult sammen med avisa
          const b = el('button', 'btn', 'Til nyeste utgave');
          b.type = 'button';
          b.addEventListener('click', () => { location.hash = ''; });
          $('notice').append(b);
        }
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
      // En tommel (eller et gammelt «lest» uten noe annet) skjuler saken; en kommentar, en
      // vault-forklaring eller en oppgave alene gjør det ikke.
      vurdFor = new Map();
      komm = new Map();
      vault = new Map();
      oppg = new Map();
      for (const d of lest.docs) {
        const v = d.data();
        if (typeof v.vurdering === 'number') vurdFor.set(d.id, v.vurdering);
        else if (!v.kommentar && v.vault == null && v.oppgave == null) vurdFor.set(d.id, 0);
        if (v.kommentar) komm.set(d.id, v.kommentar);
        if (typeof v.vault === 'string') vault.set(d.id, v.vault);
        if (typeof v.oppgave === 'string') oppg.set(d.id, v.oppgave);
      }
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
