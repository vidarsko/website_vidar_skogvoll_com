// Firebase-prosjektets nettkonfigurasjon (prosjekt «vidar-skogvoll»). Disse verdiene er OFFENTLIGE
// med vilje: de sier bare hvilket Firebase-prosjekt siden snakker med, og står i klartekst i enhver
// Firebase-side. Det som beskytter dataene er reglene i firestore.rules, ikke at denne fila er hemmelig.
//
// Hentet fra Firebase-konsollen: Project settings → General → Your apps → Web app → Config.
export const firebaseConfig = {
  apiKey: 'AIzaSyBiY-SE0ypYXmvH6x443gg04mII-MBP344',
  authDomain: 'vidar-skogvoll.firebaseapp.com',
  projectId: 'vidar-skogvoll',
  storageBucket: 'vidar-skogvoll.firebasestorage.app',
  messagingSenderId: '506491419853',
  appId: '1:506491419853:web:c230b121720d83fefbfd84',
};

// OAuth-klient-ID for Google Health API (kaloriappens vektdata). Også offentlig med vilje:
// klient-ID-en sier bare hvilken app som ber om tilgang; det er Vidar som gir tilgangen.
// Hentes fra Google Cloud-konsollen: Google Auth Platform → Clients → Web client.
export const googleClientId = '506491419853-f75q1r1dplur7eo0cqskk8ceig5jo5k1.apps.googleusercontent.com';
