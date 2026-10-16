import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, get, onValue, update } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// PLACEHOLDER: Replace with actual Firebase config
const firebaseConfig = {
    apiKey: "AIzaSyPlaceholderKeyForFirebaseConfig123",
    authDomain: "doppel-j-syndikat.firebaseapp.com",
    databaseURL: "https://doppel-j-syndikat-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "doppel-j-syndikat",
    storageBucket: "doppel-j-syndikat.appspot.com",
    messagingSenderId: "123456789012",
    appId: "1:123456789012:web:abcdef1234567890abcdef"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export { db, ref, set, get, onValue, update };
