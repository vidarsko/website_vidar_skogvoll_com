// Henter statistikken fra Firestore når Vidar er logget inn, og gir den til app.js.
//
// Dokumentet er private/stats, skrevet av .github/workflows/stats.yml (tools/push_stats.py).
// Feltet «json» holder nøyaktig den JSON-en som tools/build_stats.py lager.
// Reglene i firestore.rules er det som stenger andre ute; her vises bare en melding.

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

if (!configured) {
  say('Innloggingen er ikke satt opp ennå: js/firebase-config.js mangler verdiene fra Firebase-prosjektet.');
} else {
  const db = getFirestore(app);
  onUser(async (user) => {
    if (!user) {
      overview.replaceChildren();
      document.getElementById('detail').hidden = true;
      say('Statistikken er privat.', true);
      return;
    }
    say('Henter statistikk …');
    try {
      const snap = await getDoc(doc(db, 'private', 'stats'));
      if (!snap.exists()) {
        say('Fant ingen data ennå. Siden fylles når workflowen «Fetch stats» har kjørt.');
        return;
      }
      window.renderStats(JSON.parse(snap.data().json));
    } catch (err) {
      if (err && err.code === 'permission-denied') {
        say('Denne kontoen har ikke tilgang.');
      } else {
        say('Klarte ikke å hente data (' + (err && err.code ? err.code : 'ukjent feil') + ').');
      }
    }
  });
}
