// Henter statistikken fra Firestore når Vidar er logget inn, og gir den til app.js.
//
// Dokumentet er private/stats, skrevet av .github/workflows/stats.yml (tools/push_stats.py).
// Feltet «json» holder nøyaktig den JSON-en som tools/build_stats.py lager.
// Reglene i firestore.rules er det som stenger andre ute; her vises bare en melding.
//
// Mellomlager i nettleseren (localStorage, «stats-cache»): siste versjon vises med en gang.
// Er den sjekket den siste timen, spør siden ikke Firestore i det hele tatt. Ellers leses det
// lille dokumentet private/stats_meta (bare generated_at), og hele private/stats hentes bare
// når det er nyere enn det som ligger lagret. Mellomlageret slettes ved utlogging.

import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { app, configured, mountAuthBar, onUser, signIn, showError } from '/js/auth.js';

const notice = document.getElementById('notice');
const overview = document.getElementById('overview');

function say(text, withLogin) {
  notice.textContent = text;
  if (withLogin) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = 'Logg inn med Google';
    b.addEventListener('click', () => signIn().catch(showError));
    notice.append(b);
  }
  notice.hidden = false;
}

mountAuthBar(document.getElementById('auth'));

const CACHE = 'stats-cache';
const FRESH_MS = 60 * 60 * 1000;

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (e) { return null; }
}
function writeCache(entry) {
  try { localStorage.setItem(CACHE, JSON.stringify(entry)); } catch (e) { /* fullt eller blokkert */ }
}
function clearCache() {
  try { localStorage.removeItem(CACHE); } catch (e) {}
}

if (!configured) {
  say('Innloggingen er ikke satt opp ennå: js/firebase-config.js mangler verdiene fra Firebase-prosjektet.');
} else {
  const db = getFirestore(app);
  onUser(async (user) => {
    if (!user) {
      clearCache();
      overview.replaceChildren();
      document.getElementById('detail').hidden = true;
      say('Statistikken er privat.', true);
      return;
    }
    const cached = readCache();
    if (cached && cached.email === user.email) {
      window.renderStats(JSON.parse(cached.json));
      if (Date.now() - cached.checked < FRESH_MS) return;
    } else {
      say('Henter statistikk …');
    }
    try {
      if (cached && cached.email === user.email) {
        const meta = await getDoc(doc(db, 'private', 'stats_meta'));
        if (meta.exists() && meta.data().generated_at === cached.generated_at) {
          writeCache({ ...cached, checked: Date.now() });
          return;
        }
      }
      const snap = await getDoc(doc(db, 'private', 'stats'));
      if (!snap.exists()) {
        if (!cached) say('Fant ingen data ennå. Siden fylles når workflowen «Fetch stats» har kjørt.');
        return;
      }
      const { json, generated_at } = snap.data();
      window.renderStats(JSON.parse(json));
      writeCache({ email: user.email, generated_at, json, checked: Date.now() });
    } catch (err) {
      if (err && err.code === 'permission-denied') {
        say('Denne kontoen har ikke tilgang.');
      } else {
        const why = err && err.code ? err.code : 'ukjent feil';
        say(cached ? 'Viser den lagrede versjonen; klarte ikke å se etter en nyere (' + why + ').'
          : 'Klarte ikke å hente data (' + why + ').');
      }
    }
  });
}
