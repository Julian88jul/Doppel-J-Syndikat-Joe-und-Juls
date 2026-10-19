// Trage hier die Config deines Firebase-Projekts ein
// (Firebase Console -> Projekteinstellungen -> Allgemein -> Deine Apps -> Web-App -> SDK-Konfiguration).
// Solange hier noch "Placeholder"-Werte stehen, läuft das Spiel im lokalen Modus
// (Daten nur in diesem Browser, Tabs synchronisieren sich untereinander).
const firebaseConfig = {
    apiKey: "AIzaSyPlaceholderKeyForFirebaseConfig123",
    authDomain: "doppel-j-syndikat.firebaseapp.com",
    databaseURL: "https://doppel-j-syndikat-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "doppel-j-syndikat",
    storageBucket: "doppel-j-syndikat.appspot.com",
    messagingSenderId: "123456789012",
    appId: "1:123456789012:web:abcdef1234567890abcdef"
};

const FIREBASE_VERSION = "10.8.0";
const isPlaceholder = JSON.stringify(firebaseConfig).includes("Placeholder");

// --- Lokaler Ersatz für die Firebase-Realtime-Database (localStorage + BroadcastChannel) ---
function createLocalApi() {
    const KEY = 'djs_local_db';
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('djs_local_db') : null;
    const listeners = new Set();

    const load = () => {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; }
    };
    const parts = (path) => path.split('/').filter(Boolean);
    const getAt = (path) => {
        let node = load();
        for (const p of parts(path)) {
            if (node === null || typeof node !== 'object' || !(p in node)) return null;
            node = node[p];
        }
        return node === undefined ? null : node;
    };
    const snapshot = (val) => ({
        exists: () => val !== null && val !== undefined,
        val: () => (val === null ? null : JSON.parse(JSON.stringify(val)))
    });
    const notify = () => listeners.forEach(fn => fn());
    const write = (path, mutate) => {
        const root = load();
        const ps = parts(path);
        let node = root;
        for (const p of ps) {
            if (node[p] === null || typeof node[p] !== 'object') node[p] = {};
            node = node[p];
        }
        mutate(node, ps, root);
        localStorage.setItem(KEY, JSON.stringify(root));
        notify();
        if (channel) channel.postMessage('changed');
    };

    window.addEventListener('storage', (e) => { if (e.key === KEY) notify(); });
    if (channel) channel.onmessage = notify;

    return {
        db: {},
        ref: (db, path = '') => ({ path }),
        get: async (r) => snapshot(getAt(r.path)),
        set: async (r, value) => {
            const ps = parts(r.path);
            if (ps.length === 0) { localStorage.setItem(KEY, JSON.stringify(value)); notify(); return; }
            const last = ps.pop();
            write(ps.join('/'), (node) => { node[last] = value; });
        },
        // Wie bei Firebase: ein null-Wert löscht den Eintrag
        update: async (r, values) => write(r.path, (node) => {
            Object.entries(values).forEach(([k, v]) => { if (v === null) delete node[k]; else node[k] = v; });
        }),
        onValue: (r, cb) => {
            const fire = () => cb(snapshot(getAt(r.path)));
            listeners.add(fire);
            setTimeout(fire, 0);
            return () => listeners.delete(fire);
        }
    };
}

// --- Gemeinsamer Spielstand über server.py (WLAN-Test ohne Firebase) ---
function createServerApi() {
    const snapshot = (val) => ({
        exists: () => val !== null && val !== undefined,
        val: () => (val === null || val === undefined ? null : JSON.parse(JSON.stringify(val)))
    });
    const read = async (path) => {
        const res = await fetch(`/api/db?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Server ${res.status}`);
        return (await res.json()).value;
    };
    const write = async (op, path, value) => {
        const res = await fetch('/api/db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op, path, value })
        });
        if (!res.ok) throw new Error(`Server ${res.status}`);
    };
    return {
        db: {},
        ref: (db, path = '') => ({ path }),
        get: async (r) => snapshot(await read(r.path)),
        set: (r, value) => write('set', r.path, value),
        update: (r, values) => write('update', r.path, values),
        // Der Server kennt keine Push-Nachrichten, deshalb jede Sekunde nachsehen und nur bei Änderung melden
        onValue: (r, cb) => {
            let last;
            let stopped = false;
            const tick = async () => {
                if (stopped) return;
                try {
                    const val = await read(r.path);
                    const text = JSON.stringify(val === undefined ? null : val);
                    if (text !== last) { last = text; cb(snapshot(val)); }
                } catch (e) { /* kurzer Verbindungsabbruch: nächste Runde */ }
            };
            tick();
            const id = setInterval(tick, 1000);
            return () => { stopped = true; clearInterval(id); };
        }
    };
}

async function serverIsAvailable() {
    try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 1500);
        const res = await fetch('/api/ping', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(timer);
        return res.ok && (await res.json()).ok === true;
    } catch (e) {
        return false;
    }
}

async function createFirebaseApi() {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const [appMod, dbMod] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-database.js`)
    ]);
    const app = appMod.initializeApp(firebaseConfig);
    return {
        db: dbMod.getDatabase(app),
        ref: dbMod.ref,
        set: dbMod.set,
        get: dbMod.get,
        onValue: dbMod.onValue,
        update: dbMod.update
    };
}

// Reihenfolge: echtes Firebase, sonst gemeinsamer Test-Server (server.py), sonst nur dieser Browser
let api;
let mode = 'local';
if (!isPlaceholder) {
    try {
        api = await createFirebaseApi();
        mode = 'firebase';
    } catch (e) {
        console.error("Firebase konnte nicht geladen werden.", e);
    }
}
if (!api && await serverIsAvailable()) {
    api = createServerApi();
    mode = 'server';
}
if (!api) api = createLocalApi();

export const { db, ref, set, get, onValue, update } = api;
export const syncMode = mode;                 // 'firebase' | 'server' | 'local'
export const isLocalMode = mode !== 'firebase'; // true = kein echtes Firebase
