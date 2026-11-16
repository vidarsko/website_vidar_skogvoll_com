// Felles innlogging for alle sidene på vidar.skogvoll.com: Firebase Auth med Google-konto.
//
// Innloggingen i nettleseren er bare en dør, ikke en lås. Alle filene på siden er offentlige
// (GitHub Pages), så det som faktisk er privat ligger i Firestore og beskyttes av firestore.rules.
// Se «Innlogging og hva som er privat» i AGENTS.md.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { firebaseConfig } from '/js/firebase-config.js';

export const configured = !String(firebaseConfig.apiKey).startsWith('FYLL_INN');
export const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = configured ? getAuth(app) : null;

export function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return signInWithPopup(auth, provider);
}

export function logOut() {
  return signOut(auth);
}

// Kaller cb(user) nå og ved hver endring; user er null når ingen er logget inn.
export function onUser(cb) {
  if (!configured) { cb(null); return; }
  onAuthStateChanged(auth, cb);
}

// Fyller innloggingsfeltet i toppen (#auth) med «Logg inn» eller navn + «Logg ut».
export function mountAuthBar(el) {
  function render(user) {
    el.replaceChildren();
    if (!configured) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    if (user) {
      const name = document.createElement('span');
      name.className = 'auth-name';
      name.textContent = user.displayName || user.email;
      button.textContent = 'Logg ut';
      button.addEventListener('click', () => logOut());
      el.append(name, button);
    } else {
      button.textContent = 'Logg inn';
      button.addEventListener('click', () => signIn().catch(showError));
      el.append(button);
    }
  }
  onUser(render);
}

export function showError(err) {
  // Lukket popup er ikke en feil.
  if (err && err.code === 'auth/popup-closed-by-user') return;
  const n = document.getElementById('notice');
  if (!n) return;
  n.textContent = 'Innloggingen feilet (' + (err && err.code ? err.code : 'ukjent feil') + ').';
  n.hidden = false;
}
