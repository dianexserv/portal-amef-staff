// Inițializare Firebase Web SDK pentru Google SSO.
//
// În MVP folosim DOAR provider-ul Google (decizie D6) — popup-ul Google e
// declanșat din LoginPage la click. Token-ul de la Firebase (idToken) e
// trimis spre backend la /api/v1/auth/firebase-login, care îl validează cu
// firebase-admin și emite JWT-ul propriu.
//
// `import.meta.env.VITE_*` — Vite expune doar variabilele cu prefix VITE_
// la browser (restul sunt server-side). Asta e ON BY DESIGN: previne ca o
// variabilă "secretă" să ajungă accidental în bundle-ul JS public. Cheile
// Firebase NU sunt secrete (sunt menite să fie publice — restricția se face
// pe domeniul de origine în Firebase console + pe rolurile din DB).

import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Forțăm prompt account selection la fiecare sign-in — utilul când
// utilizatorul are mai multe conturi Google în browser și vrem să-l lăsăm
// să aleagă explicit (în loc să i se dea automat ultimul folosit).
googleProvider.setCustomParameters({ prompt: 'select_account' });
