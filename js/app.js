import { db, ref, set, get, onValue, update, isLocalMode, syncMode } from './firebase-config.js?v=20261021a';

// Versionsanzeige: so sieht man auf dem Handy sofort, ob die neue Version geladen wurde und in welchem Modus gespielt wird
const APP_BUILD = '20261021a';
const MODE_LABELS = { firebase: 'Firebase (online)', server: 'Test-Server (WLAN)', local: 'nur dieses Gerät' };

// --- CONFIG & STATE ---
const PIN_CODE = "1337"; // Example PIN
let currentUserRole = null; // 'Juls' or 'Joe'
// Lokales Datum (toISOString wäre UTC und würde den Tag um Mitternacht falsch wechseln)
const todayDate = new Date();
let currentDayStr = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`;
let isEvenDay = todayDate.getDate() % 2 === 0; // Defines role swap for Stage 2

// Vergleich von Antworten: Groß-/Kleinschreibung, Leerzeichen und Satzzeichen am Rand ignorieren
// ("Brawl Stars", "brawlstars" und "Brawl-Stars!" gelten als gleich)
function normalizeAnswer(str) {
    return String(str || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '');
}

// Trifft die Antwort eine der Ziel-Antworten? ("mit dem Moped" enthält "moped")
function matchesTarget(answer, targets) {
    const a = normalizeAnswer(answer);
    return a.length > 0 && targets.some(t => a.includes(normalizeAnswer(t)));
}
let isMuted = false;

// --- SOUNDS (Synthesized for self-containment) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// Handy-Lautsprecher sind leise: Alles läuft über einen Master-Regler mit Kompressor
const masterGain = audioCtx.createGain();
masterGain.gain.value = 2.2;
const compressor = audioCtx.createDynamicsCompressor();
masterGain.connect(compressor);
compressor.connect(audioCtx.destination);

// iOS Safari (ab 17) spielt Web-Audio sonst nicht ab, wenn der Klingelton-Schalter auf lautlos steht
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

// Mobile Browser erlauben Ton erst nach einer Berührung: bei jeder Geste entsperren, bis es läuft
function unlockAudio() {
    if (audioCtx.state !== 'running') {
        audioCtx.resume().catch(() => {});
        // Kurzer stiller Ton "weckt" den Audio-Kanal, vor allem auf iPhones
        const buf = audioCtx.createBuffer(1, 1, 22050);
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(audioCtx.destination);
        src.start(0);
    }
    if (audioCtx.state === 'running') {
        ['touchstart', 'touchend', 'pointerdown', 'click', 'keydown'].forEach(ev => document.removeEventListener(ev, unlockAudio, true));
    }
}
['touchstart', 'touchend', 'pointerdown', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, unlockAudio, true));
// Nach Tab-Wechsel oder Anruf kann der Ton "interrupted" sein
document.addEventListener('visibilitychange', () => { if (!document.hidden) audioCtx.resume().catch(() => {}); });

function playTone(freq, type, duration, vol) {
    if (isMuted) return;
    if (audioCtx.state !== 'running') {
        // Noch nicht entsperrt: versuchen zu entsperren, der Ton selbst wird übersprungen
        audioCtx.resume().catch(() => {});
        return;
    }
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

    gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);

    osc.connect(gainNode);
    gainNode.connect(masterGain);

    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}

function playSound(soundType) {
    if (audioCtx.state !== 'running') {
        audioCtx.resume().catch(() => {});
    }

    if (soundType === 'typewriter') {
        // Quick sharp click
        playTone(600 + Math.random() * 200, 'square', 0.05, 0.1);
    } else if (soundType === 'stamp') {
        // Deep thud
        playTone(100, 'sine', 0.2, 0.5);
        setTimeout(() => playTone(80, 'square', 0.1, 0.3), 50);
    } else if (soundType === 'win') {
        [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => playTone(f, 'triangle', 0.25, 0.25), i * 120));
    } else if (soundType === 'lose') {
        [330, 262, 196, 130].forEach((f, i) => setTimeout(() => playTone(f, 'sawtooth', 0.35, 0.2), i * 220));
    } else if (soundType === 'tick') {
        playTone(1250, 'square', 0.04, 0.22);
    } else if (soundType === 'tock') {
        playTone(900, 'square', 0.05, 0.22);
    } else if (soundType === 'pop') {
        playTone(700, 'sine', 0.08, 0.3);
    } else if (soundType === 'alarm') {
        [880, 660, 880, 660].forEach((f, i) => setTimeout(() => playTone(f, 'square', 0.18, 0.15), i * 200));
    } else if (soundType === 'creak') {
        // High pitched descending squeak
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.5);
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        osc.connect(gainNode);
        gainNode.connect(masterGain);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.5);
    }
}

// --- DOM ELEMENTS ---
const screens = {
    login: document.getElementById('screen-login'),
    roleSelect: document.getElementById('screen-role-select'),
    game: document.getElementById('screen-game'),
    smuggle: document.getElementById('screen-smuggle')
};

// Login
const pinInput = document.getElementById('pin-input');
const pinSubmitBtn = document.getElementById('pin-submit');
const pinError = document.getElementById('pin-error');

// Role Select
const roleCards = document.querySelectorAll('.file-card');

// Stats
const statsBoard = document.getElementById('stats-board');
const streakCountSpan = document.getElementById('streak-count');
const gangsterRankSpan = document.getElementById('gangster-rank');

// Panning & Scene UI
const sceneContainer = document.getElementById('scene-container');
const gum = document.getElementById('gum');

// Modals & Table UI
const closedFile = document.getElementById('closed-file');
const openFileModal = document.getElementById('open-file-modal');
const btnCloseFile = document.getElementById('btn-close-file');

const scrapPaper = document.getElementById('scrap-paper');
const scrapModal = document.getElementById('scrap-modal');
const btnCloseScrap = document.getElementById('btn-close-scrap');

// File Cover
const coverCaseTitle = document.getElementById('cover-case-title');
const coverCaseDesc = document.getElementById('cover-case-desc');
const coverQ1 = document.getElementById('cover-q1');

// Game UI
const caseName = document.getElementById('case-name');
const q1Text = document.getElementById('q1-text');
const a1Input = document.getElementById('a1-input');
const btnSubmit1 = document.getElementById('btn-submit-1');
const status1 = document.getElementById('status-1');

const stage1 = document.getElementById('stage-1');
const stage2 = document.getElementById('stage-2');
const stage3 = document.getElementById('stage-3');
const stageResult = document.getElementById('stage-result');

const s2SetterView = document.getElementById('s2-setter-view');
const s2GuesserHintView = document.getElementById('s2-guesser-hint-view');
const s2GuesserView = document.getElementById('s2-guesser-view');
const s2WordInput = document.getElementById('s2-word-input');
const s2EmojiInput = document.getElementById('s2-emoji-input');
const btnSubmit2Set = document.getElementById('btn-submit-2-set');
const s2LengthHint = document.getElementById('s2-length-hint');
const s2EmojiHint = document.getElementById('s2-emoji-hint');
const s2GuessInput = document.getElementById('s2-guess-input');
const btnSubmit2Guess = document.getElementById('btn-submit-2-guess');
const status2 = document.getElementById('status-2');

const q3Text = document.getElementById('q3-text');
const itemGrid = document.getElementById('item-grid');
const tableItems = document.getElementById('table-items');
const status3 = document.getElementById('status-3');

const dialogSystem = document.getElementById('dialog-system');
const dialogText = document.getElementById('dialog-text');

const resJuls = document.getElementById('res-juls');
const resJoe = document.getElementById('res-joe');
const finalVerdict = document.getElementById('final-verdict');

// Level 4: Panik
const panicSection = document.getElementById('panic-section');
const panicSecondsEl = document.getElementById('panic-seconds');
const panicHud = document.getElementById('panic-hud');
const panicHudSeconds = document.getElementById('panic-hud-seconds');
const panicMine = document.getElementById('panic-mine');
const panicTheirs = document.getElementById('panic-theirs');
const panicPartnerLabel = document.getElementById('panic-partner-label');
const panicLog = document.getElementById('panic-log');
const panicInput = document.getElementById('panic-input');
const btnPanicSend = document.getElementById('btn-panic-send');

const detectivesBg = document.querySelector('.detectives-bg');

// Smuggle UI
const hiddenSmuggleBtn = document.getElementById('hidden-smuggle-btn');
const newCaseTitle = document.getElementById('new-case-title');
const newQ1 = document.getElementById('new-q1');
const newQ3 = document.getElementById('new-q3');
const btnSmuggleSave = document.getElementById('btn-smuggle-save');
const btnSmuggleBack = document.getElementById('btn-smuggle-back');

// --- INIT ---
function init() {
    // Setup audio toggles
    document.getElementById('mute-btn').addEventListener('click', () => {
        isMuted = !isMuted;
        document.getElementById('mute-btn').innerText = isMuted ? '🔇' : '🔊';
    });

    // Typewriter sound on input
    document.querySelectorAll('input[type="text"]').forEach(input => {
        input.addEventListener('input', () => playSound('typewriter'));
    });

    document.querySelectorAll('.build-info').forEach(el => {
        el.textContent = `Version ${APP_BUILD} · Modus: ${MODE_LABELS[syncMode] || syncMode}`;
    });

    if (isLocalMode) {
        // Neustart-Knöpfe: Kopfzeile im Spiel und gut sichtbar schon auf der Rollenwahl
        ['reset-btn', 'reset-start'].forEach(id => {
            const btn = document.getElementById(id);
            btn.classList.remove('hidden');
            btn.addEventListener('click', restartToday);
        });

        const banner = document.createElement('div');
        banner.className = 'local-banner';
        banner.innerText = syncMode === 'server'
            ? 'Test-Server: Spielstand wird mit allen Geräten im WLAN geteilt.'
            : 'Lokaler Modus: Firebase ist nicht eingerichtet, Spielstand bleibt nur in diesem Browser.';
        banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;padding:4px 8px;font-size:12px;text-align:center;background:#222;color:#e0c97f;opacity:.85;pointer-events:none;';
        document.body.appendChild(banner);
    }

    // Check login
    if (localStorage.getItem('djs_unlocked') === 'true') {
        showScreen('roleSelect');
    } else {
        showScreen('login');
    }
}

// --- NAVIGATION ---
function showScreen(screenKey) {
    Object.values(screens).forEach(s => {
        s.classList.remove('active');
        s.classList.add('hidden');
    });
    screens[screenKey].classList.remove('hidden');
    screens[screenKey].classList.add('active');
}

// --- PANNING LOGIC ---
// Umsehen: Maus (PC) oder Wischen mit dem Finger (Handy), dazu ein Button zum Nach-unten-Schauen.
// x, y: 0 bis 1 (0 = ganz oben/links). Der Bereich wird aus der echten Szenengröße berechnet,
// damit nie schwarze Ränder sichtbar werden.
let panX = 0.5;
let panY = 0.5;
function panScene(x, y) {
    panX = Math.max(0, Math.min(1, x));
    panY = Math.max(0, Math.min(1, y));
    const cs = getComputedStyle(sceneContainer);
    const left = parseFloat(cs.left) || 0;
    const top = parseFloat(cs.top) || 0;
    const w = sceneContainer.offsetWidth;
    const h = sceneContainer.offsetHeight;
    const maxX = -left;
    const minX = Math.min(maxX, window.innerWidth - left - w);
    const maxY = -top;
    const minY = Math.min(maxY, window.innerHeight - top - h);
    const tx = maxX + (minX - maxX) * panX;
    const ty = maxY + (minY - maxY) * panY;
    sceneContainer.style.transform = `translate(${tx}px, ${ty}px)`;
}

const isTouchDevice = window.matchMedia('(hover: none), (pointer: coarse)').matches;
const lookBtn = document.getElementById('look-btn');

function updateLookBtn() {
    const down = panY > 0.5;
    lookBtn.innerText = down ? '👆 Zum Tisch' : '👇 Unter den Tisch';
}

function gameIsActive() {
    return screens.game.classList.contains('active');
}
function anyModalOpen() {
    return !openFileModal.classList.contains('hidden') || !scrapModal.classList.contains('hidden') ||
        !screens.smuggle.classList.contains('hidden');
}

function handleMouseMove(e) {
    if (!gameIsActive() || isTouchDevice) return;
    panScene(e.clientX / window.innerWidth, e.clientY / window.innerHeight);
}
window.addEventListener('mousemove', handleMouseMove);

// Handy: mit dem Finger wischen, um sich im Raum umzusehen
let touchLast = null;
window.addEventListener('touchstart', (e) => {
    const onUi = e.target.closest && e.target.closest('.file-modal, .scrap-modal, .action-bar, .stats-board, .login-box, button, input');
    touchLast = (!onUi && e.touches.length === 1) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
window.addEventListener('touchmove', (e) => {
    if (!touchLast || !gameIsActive() || anyModalOpen()) return;
    const t = e.touches[0];
    const dx = t.clientX - touchLast.x;
    const dy = t.clientY - touchLast.y;
    touchLast = { x: t.clientX, y: t.clientY };
    // Finger nach oben = nach unten schauen, Finger nach links = nach rechts schauen
    panScene(panX - dx / window.innerWidth * 1.8, panY - dy / window.innerHeight * 1.8);
    updateLookBtn();
}, { passive: true });
window.addEventListener('touchend', () => { touchLast = null; }, { passive: true });

// Button als Alternative zum Wischen: zwischen Tisch und Unterseite wechseln
lookBtn.addEventListener('click', () => {
    panScene(0.5, panY > 0.5 ? 0 : 1);
    updateLookBtn();
    playSound('creak');
});

// --- KEYBOARD ---
// Enter sendet das aktive Eingabefeld ab, Escape schließt offene Fenster
const enterTargets = {
    'pin-input': pinSubmitBtn,
    'a1-input': btnSubmit1,
    's2-guess-input': btnSubmit2Guess,
    's2-emoji-input': btnSubmit2Set,
    'panic-input': btnPanicSend
};
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && enterTargets[e.target.id] && !enterTargets[e.target.id].disabled) {
        enterTargets[e.target.id].click();
    } else if (e.key === 'Escape') {
        openFileModal.classList.add('hidden');
        scrapModal.classList.add('hidden');
    }
});

// --- PROGRESS ---
function updateProgress(data) {
    let step = 1;
    if (data.stage1 && data.stage1.Juls && data.stage1.Joe) step = 2;
    if (data.stage2 && data.stage2.guess) step = 3;
    if (data.stage3 && data.stage3.Juls && data.stage3.Joe) step = 4;
    document.querySelectorAll('.progress-step').forEach(el => {
        const n = Number(el.dataset.step);
        el.classList.toggle('done', n < step);
        el.classList.toggle('current', n === step);
    });
}

// --- MODAL LOGIC ---
let fileEverOpened = false; // Die Akte muss am Anfang erst aufgehoben werden
let lastBarData = null;

// Nach einer abgegebenen Antwort klappt die Akte zu (Stufe geschafft)
function closeFileSoon() {
    setTimeout(() => openFileModal.classList.add('hidden'), 900);
}
closedFile.addEventListener('click', () => {
    // Do not allow clicking if the game screen hasn't formally started
    if (!screens.game.classList.contains('active')) return;

    playSound('stamp'); // Placeholder for open sound
    openFileModal.classList.remove('hidden');
    if (!fileEverOpened) {
        fileEverOpened = true;
        btnBarFile.innerText = '📂 Akte';
        btnBarFile.title = 'Akte öffnen';
        if (lastBarData) refreshActionBar(...lastBarData);
    }
});

btnCloseFile.addEventListener('click', () => {
    playSound('stamp'); // Placeholder for close sound
    openFileModal.classList.add('hidden');
});

scrapPaper.addEventListener('click', () => {
    // Do not allow clicking if the game screen hasn't formally started
    if (!screens.game.classList.contains('active')) return;

    playSound('stamp');
    scrapModal.classList.remove('hidden');
});

btnCloseScrap.addEventListener('click', () => {
    playSound('stamp');
    scrapModal.classList.add('hidden');
});


// --- LOGIN LOGIC ---
pinSubmitBtn.addEventListener('click', () => {
    if (pinInput.value === PIN_CODE) {
        localStorage.setItem('djs_unlocked', 'true');
        showScreen('roleSelect');
    } else {
        pinError.classList.remove('hidden');
    }
});

// --- ROLE SELECTION LOGIC ---
roleCards.forEach(card => {
    card.addEventListener('click', async () => {
        currentUserRole = card.getAttribute('data-role');

        await loadDailyCase();

        // Fade out role select
        screens.roleSelect.classList.add('fade-out');

        setTimeout(() => {
            showScreen('game'); // Make game anchor active so panning triggers
            statsBoard.classList.remove('hidden');
            if (isTouchDevice) lookBtn.classList.remove('hidden');

            // Remove intro zoom, pulling the player to the table
            sceneContainer.classList.remove('intro-view');
            panScene(0.5, isTouchDevice ? 0 : 0.5); // Blick auf Detektive und Tisch

            listenToGameState();
            loadStats();

            // Start dialogue
            speak(`${activeCase.desc} ${activeCase.q1}`, 9000, activeCase.speaker);
            // Die Akte liegt auf dem Tisch: Der Spieler muss sie erst aufheben (Klick auf die Akte)
        }, 500); // short wait to let UI fade out before panning into table
    });
});


// --- GAME LOGIC ---

// --- DIALOG SYSTEM ---
let currentDialogInterval;
let currentDialogTimeout;
let lastSpeaker = 'schatten';

const DETECTIVES = {
    grimm: { name: 'Kommissar Grimm', el: document.querySelector('.detective.grimm') },
    schatten: { name: 'Detektiv Schatten', el: document.querySelector('.detective.schatten') }
};

// who: 'grimm' | 'schatten' (ohne Angabe wechseln sich beide ab)
function speak(text, duration = 5000, who) {
    clearInterval(currentDialogInterval);
    clearTimeout(currentDialogTimeout);

    if (!who) who = lastSpeaker === 'grimm' ? 'schatten' : 'grimm';
    lastSpeaker = who;
    // 'speaking' = Untertitel steht (Figur leuchtet leicht), 'talking' = nur solange gesprochen wird (Mund bewegt sich)
    Object.values(DETECTIVES).forEach(d => d.el && d.el.classList.remove('speaking', 'talking'));
    if (DETECTIVES[who].el) DETECTIVES[who].el.classList.add('speaking', 'talking');

    // Sprechername farbig (Grimm glutrot, Schatten eisblau), danach wird der Satz getippt
    const full = `„${text}“`;
    dialogText.innerHTML = '';
    const nameEl = document.createElement('span');
    nameEl.className = `speaker-name ${who}`;
    nameEl.textContent = DETECTIVES[who].name;
    const lineEl = document.createElement('span');
    lineEl.className = 'speaker-line';
    dialogText.append(nameEl, lineEl);

    const step = full.length > 120 ? 22 : 40; // lange Texte schneller tippen
    let i = 0;
    currentDialogInterval = setInterval(() => {
        lineEl.textContent += full.charAt(i);
        if (i % 2 === 0 && full.charAt(i).trim() !== '') playSound('typewriter');
        i++;
        if (i >= full.length) {
            clearInterval(currentDialogInterval);
            // Satz zu Ende: Mund schließt sich sofort wieder
            if (DETECTIVES[who].el) DETECTIVES[who].el.classList.remove('talking');
            currentDialogTimeout = setTimeout(() => {
                dialogText.innerText = '';
                if (DETECTIVES[who].el) DETECTIVES[who].el.classList.remove('speaking');
            }, duration);
        }
    }, step);
}

// --- VERDICT EFFECTS ---
const verdictStamp = document.getElementById('verdict-stamp');
function showVerdictStamp(text, type) {
    verdictStamp.innerText = text;
    verdictStamp.className = `verdict-stamp ${type}`;
    clearTimeout(showVerdictStamp.t);
    showVerdictStamp.t = setTimeout(() => verdictStamp.classList.add('hidden'), 3200);
}
function shakeScreen() {
    document.body.classList.add('shake');
    setTimeout(() => document.body.classList.remove('shake'), 600);
}

// --- GAME LOGIC ---

// type 'personal': feste Ziel-Antwort (targets), type 'general': beide müssen dasselbe Wort tippen
const CASES_VERSION = 3; // 3: Alibi-Fragen für Level 3
const hardcodedCases = [
    { id: 'case_1', type: 'personal', speaker: 'grimm', title: "Der Schmuggel an der Ostsee",
      desc: "Wir haben Berichte über Schmuggelware an der Küste. Sie behaupten, Sie waren dort nur für Ihren einzigen gemeinsamen Urlaub.",
      q1: "Wenn das stimmt: Wie heißt der genaue Ort an der Ostsee?", q3: "Sie behaupten, Sie hätten den Abend ganz unschuldig am Strand verbracht. Welchen dieser Gegenstände hatten Sie dabei angeblich in der Tasche?", targets: ["Scharbeutz"] },
    { id: 'case_2', type: 'personal', speaker: 'schatten', title: "Lärmbelästigung oder Bandenkrieg?",
      desc: "Die Nachbarn haben extreme Schreie aus Ihrer Wohnung gemeldet. Sie schieben es auf ein harmloses Videospiel.",
      q1: "Welches Spiel hat Sie angeblich so ausrasten lassen?", q3: "Sie behaupten, Sie hätten nur friedlich gezockt. Welcher dieser Gegenstände lag dabei angeblich neben der Konsole?", targets: ["Brawl Stars"] },
    { id: 'case_3', type: 'personal', speaker: 'grimm', title: "Der auffällige Flucht-Unfall",
      desc: "Am Tatort wurden seltsame Schleifspuren gefunden. Sie behaupten, Joe hätte sich einfach mal wieder das Knie gebrochen.",
      q1: "Womit genau ist sie damals angeblich verunglückt?", q3: "Sie behaupten, es war nur ein harmloser Ausflug. Welchen dieser Gegenstände hatten Sie angeblich im Rucksack dabei?", targets: ["E-Scooter", "Scooter"] },
    { id: 'case_4', type: 'personal', speaker: 'schatten', title: "Die abgehörte Funkfrequenz",
      desc: "Wir haben Ihren Funkverkehr abgehört. Jemand rief panisch: 'Schnell, steig auf, Bebi Maus!'",
      q1: "Womit genau sind Sie beide danach in die Nacht geflüchtet?", q3: "Sie behaupten, Sie seien nur zum Eisessen gefahren. Welchen dieser Gegenstände hatten Sie angeblich im Helmfach?", targets: ["Moped"] },
    { id: 'case_5', type: 'general', speaker: 'grimm', title: "Die tierische Sabotage",
      desc: "Die Überwachungskameras wurden von einem Tier sabotiert, das Sie heimlich trainiert haben.",
      q1: "Welches Tier haben Sie durch den Lüftungsschacht geschickt?", q3: "Sie behaupten, Sie waren zur Tatzeit unschuldig im Park spazieren. Welchen kuriosen Gegenstand hatten Sie laut Ihrer Aussage zufällig in der Tasche?" },
    { id: 'case_6', type: 'general', speaker: 'schatten', title: "Das unauffällige Fast-Food",
      desc: "Sie behaupten, Sie waren zur Tatzeit in einem Drive-in. Wir haben den Wagen durchsucht.",
      q1: "Welches Fast-Food-Gericht lag angeblich noch auf dem Beifahrersitz?", q3: "Um Ihr Alibi zu beweisen: Welchen dieser Gegenstände haben Sie an dem Abend im Drive-in angeblich aufs Armaturenbrett gelegt?" },
    { id: 'case_7', type: 'general', speaker: 'grimm', title: "Der Haushalts-Ausbruch",
      desc: "Jemand hat das Schloss zur Tresorkammer mit einem völlig ungeeigneten Gegenstand aus der Küche geknackt.",
      q1: "Was haben Sie als Werkzeug zweckentfremdet?", q3: "Sie behaupten, Sie hätten an dem Abend nur gekocht. Welcher dieser Gegenstände lag dabei angeblich auf der Arbeitsplatte?" },
    { id: 'case_8', type: 'general', speaker: 'schatten', title: "Der falsche Deckname",
      desc: "Ein Zeuge hat gehört, wie Sie Ihren Komplizen bei der Flucht mit dem Namen eines Charakters aus Ihrer gemeinsamen Lieblingsserie gerufen haben.",
      q1: "Welcher Name war das?", q3: "Sie behaupten, Sie hätten den ganzen Abend Serie geschaut. Welchen dieser Gegenstände hatten Sie dabei angeblich auf dem Sofa liegen?" }
];

let activeCase = hardcodedCases[0];

function withTimeout(promise, ms = 3000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
    ]);
}

// Fälle ohne Typ (z.B. selbst geschmuggelte) gelten als allgemeine Fälle
// Neues Indiz vor der finalen Frage, damit der Fall eine zusammenhängende Geschichte ergibt
const CLUES = {
    case_1: "Im Strandkorb lag ein Zettel mit Ihren Initialen.",
    case_2: "Auf dem Flur lag ein zerbrochener Controller.",
    case_3: "Neben den Schleifspuren fanden wir einen verbogenen Lenker.",
    case_4: "Die Aufnahme endet mit Knattern und lautem Gelächter.",
    case_5: "In der Lüftung klebten Tierhaare und ein halbes Leckerli.",
    case_6: "Auf dem Beifahrersitz fanden wir Fettflecken und Ketchup.",
    case_7: "Am Schloss entdeckten wir Kratzer und Reste von Bratfett.",
    case_8: "Der Zeuge schwört, Sie hätten dabei laut gekichert."
};

// Alibi-Frage für die geheime Notiz (Stufe 2): Die Antwort ist das Alibi, das der Partner erraten muss
const ALIBI_QUESTIONS = {
    case_1: "Euer Alibi: Was habt ihr an dem Abend am Strand gemacht?",
    case_2: "Euer Alibi: Was habt ihr nach dem Spiel gegessen?",
    case_3: "Euer Alibi: Wohin wolltet ihr an dem Tag eigentlich fahren?",
    case_4: "Euer Alibi: Wohin ging eure nächtliche Flucht?",
    case_5: "Euer Alibi: Wo habt ihr das Tier trainiert?",
    case_6: "Euer Alibi: Welche Soße habt ihr im Drive-in bestellt?",
    case_7: "Euer Alibi: Was habt ihr währenddessen in der Küche gekocht?",
    case_8: "Euer Alibi: Wo habt ihr die Serie an dem Abend geschaut?"
};

function normalizeCase(id, c) {
    return {
        id,
        q2: c.q2 || ALIBI_QUESTIONS[id] || "Euer Alibi: Wo wart ihr zur Tatzeit?",
        clue: c.clue || CLUES[id] || "Wir haben noch etwas am Tatort gefunden.",
        type: c.type === 'personal' ? 'personal' : 'general',
        speaker: c.speaker === 'schatten' ? 'schatten' : 'grimm',
        title: c.title || 'Unbekannter Fall',
        desc: c.desc || '',
        q1: c.q1 || '',
        q3: c.q3 || '',
        targets: c.targets ? Object.values(c.targets) : []
    };
}

// Stellt sicher, dass die Datenbank die aktuelle Fallliste enthält: alte Fälle
// (z.B. die Kleingartenanlage) werden gelöscht, selbst geschmuggelte Fälle bleiben.
async function seedCases() {
    const versionSnap = await withTimeout(get(ref(db, 'meta/casesVersion')));
    if (versionSnap.exists() && versionSnap.val() >= CASES_VERSION) return;

    const updates = {};
    hardcodedCases.forEach(c => { const { id, ...rest } = c; updates[id] = rest; });

    const casesSnap = await withTimeout(get(ref(db, 'cases')));
    if (casesSnap.exists()) {
        Object.entries(casesSnap.val()).forEach(([key, c]) => {
            const text = JSON.stringify(c || '').toLowerCase();
            // Schlüssel der neuen Liste werden ohnehin überschrieben, nur übrige Altfälle löschen
            if (text.includes('kleingarten') && !(key in updates)) updates[key] = null;
        });
    }
    await withTimeout(update(ref(db, 'cases'), updates), 4000);
    await withTimeout(update(ref(db, 'meta'), { casesVersion: CASES_VERSION }), 4000);
}

// Zufälliger, aber für beide Spieler identischer Fall pro Tag (Seed = Datum)
function pickCaseForDay(caseList, dayStr) {
    let seed = 0;
    for (const ch of dayStr) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    seed = (seed ^ 0x9e3779b9) >>> 0;
    seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0;
    seed = Math.imul(seed ^ (seed >>> 13), 3266489909) >>> 0;
    return caseList[((seed ^ (seed >>> 16)) >>> 0) % caseList.length];
}

// --- LEVEL 3: Die 10 beschlagnahmten Gegenstände (Tascheninhalte für das Alibi) ---
const ALIBI_ITEMS = [
    { id: 'puempel', name: 'Pümpel', icon: '🪠' },
    { id: 'alien', name: '3D-gedrucktes Alien', icon: '👽' },
    { id: 'klobuerste', name: 'Klobürste', icon: '🧹' },
    { id: 'schlauch', name: 'Gartenschlauch', icon: '🪢' },
    { id: 'ente', name: 'Quietscheente', icon: '🦆' },
    { id: 'lippenstift', name: 'Lippenstift', icon: '💄' },
    { id: 'schluessel', name: 'Abgebrochener Schlüssel', icon: '🗝️' },
    { id: 'taschenuhr', name: 'Taschenuhr', icon: '⏱️' },
    { id: 'kaktus', name: 'Kaktus', icon: '🌵' },
    { id: 'klapphandy', name: 'Klapphandy', icon: '📱' }
];
// Feste Plätze auf dem Tisch links und rechts der Akte (in % der Tischfläche)
const TABLE_SPOTS = [
    [4, 14], [17, 36], [6, 58], [22, 70], [12, 84],
    [76, 16], [88, 36], [72, 60], [90, 66], [80, 84]
];

function itemById(id) {
    return ALIBI_ITEMS.find(i => i.id === id);
}
function itemLabel(id) {
    const it = itemById(id);
    return it ? `${it.icon} ${it.name}` : (id || '-');
}

// Pro Tag gemischt, aber für beide Spieler in derselben Reihenfolge
function itemsForDay(dayStr) {
    let seed = 7;
    for (const ch of dayStr) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
    const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x6d2b79f5) >>> 0; return seed / 4294967296; };
    const list = [...ALIBI_ITEMS];
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

function renderAlibiItems() {
    const items = itemsForDay(currentDayStr);
    itemGrid.innerHTML = '';
    tableItems.innerHTML = '';
    items.forEach((it, idx) => {
        const btn = document.createElement('button');
        btn.className = 'item-card';
        btn.dataset.item = it.id;
        btn.innerHTML = `<span class="item-icon">${it.icon}</span><span class="item-name">${it.name}</span>`;
        btn.addEventListener('click', () => chooseAlibiItem(it.id));
        itemGrid.appendChild(btn);

        // Dieselben Gegenstände liegen auch in der Szene auf dem Tisch; Antippen öffnet die Akte
        const onTable = document.createElement('div');
        onTable.className = 'table-item';
        onTable.title = it.name;
        onTable.textContent = it.icon;
        const [x, y] = TABLE_SPOTS[idx % TABLE_SPOTS.length];
        onTable.style.left = `${x}%`;
        onTable.style.top = `${y}%`;
        onTable.style.setProperty('--rot', `${(idx * 37) % 50 - 25}deg`);
        onTable.addEventListener('click', () => closedFile.click());
        tableItems.appendChild(onTable);
    });
}

async function loadDailyCase() {
    let caseList = hardcodedCases.map(c => normalizeCase(c.id, c));
    let chosenId = null;

    try {
        await seedCases();

        const casesSnap = await withTimeout(get(ref(db, 'cases')));
        if (casesSnap.exists()) {
            const fromDb = Object.entries(casesSnap.val())
                .filter(([, c]) => c && c.q1)
                .map(([id, c]) => normalizeCase(id, c));
            if (fromDb.length) caseList = fromDb;
        }

        // Hat heute schon jemand einen Fall festgelegt? Dann denselben nehmen.
        const dailySnap = await withTimeout(get(ref(db, `daily/${currentDayStr}/caseId`)));
        if (dailySnap.exists()) chosenId = dailySnap.val();
    } catch (e) {
        console.warn("Datenbank nicht erreichbar, nutze lokale Fälle.", e);
    }

    caseList.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    activeCase = caseList.find(c => c.id === chosenId) || pickCaseForDay(caseList, currentDayStr);

    // Fall für den Partner festhalten (fire and forget)
    if (chosenId !== activeCase.id) {
        withTimeout(update(ref(db, `daily/${currentDayStr}`), { caseId: activeCase.id })).catch(() => {});
    }

    // Populate Modal File
    caseName.innerText = activeCase.title;
    q1Text.innerText = activeCase.q1;
    q3Text.innerText = activeCase.q3;
    document.getElementById('case-badge').innerText = activeCase.type === 'personal'
        ? '🔒 Persönlicher Fall – nur ihr beide kennt die Antwort'
        : '🎲 Allgemeiner Fall – tippt ohne Absprache dasselbe Wort';

    // Populate Cover (Table)
    coverCaseTitle.innerText = activeCase.title;
    coverCaseDesc.innerText = activeCase.desc || "Ermittlung läuft...";
    coverQ1.innerText = "Frage 1: " + activeCase.q1;

    renderAlibiItems();

    // Alibi-Frage der Notiz (Stufe 2)
    document.getElementById('s2-question-file').innerText = activeCase.q2;
    document.getElementById('scrap-question').innerText = activeCase.q2;

    setupStage2Roles();
}

const DISPLAY_NAMES = { Juls: 'Julian', Joe: 'Joe' };

function setupStage2Roles() {
    const setterRole = isEvenDay ? 'Juls' : 'Joe';
    const partnerRole = setterRole === 'Juls' ? 'Joe' : 'Juls';
    document.getElementById('scrap-title').innerText = currentUserRole === setterRole
        ? `Notiz für ${DISPLAY_NAMES[partnerRole]}`
        : `Notiz von ${DISPLAY_NAMES[setterRole]}`;
    if (currentUserRole === setterRole) {
        s2SetterView.classList.remove('hidden');
        s2GuesserHintView.classList.add('hidden');
        s2GuesserView.classList.add('hidden');
    } else {
        s2SetterView.classList.add('hidden');
        s2GuesserHintView.classList.remove('hidden');
        s2GuesserView.classList.remove('hidden');
    }
}

function listenToGameState() {
    const dailyRef = ref(db, `daily/${currentDayStr}`);
    let hadData = false;
    onValue(dailyRef, (snapshot) => {
        const data = snapshot.val() || {};
        const hasData = Object.keys(data).length > 0;
        // Wurde der Tag auf einem anderen Gerät zurückgesetzt, hier ebenfalls neu starten
        if (hadData && !hasData) { location.reload(); return; }
        if (hasData) hadData = true;
        updateUIBasedOnState(data);
    });
}

// Jede Dialogzeile nur einmal sprechen, auch wenn die Daten sich mehrfach aktualisieren
const spoken = {};
function sayOnce(key, text, duration, who, delay = 0) {
    if (spoken[key]) return;
    spoken[key] = true;
    if (delay) setTimeout(() => speak(text, duration, who), delay);
    else speak(text, duration, who);
}

// Feste Leiste oben: Akte und Kassiber sind jederzeit erreichbar, dazu der nächste Schritt
const actionBar = document.getElementById('action-bar');
const btnBarFile = document.getElementById('bar-file');
const btnBarScrap = document.getElementById('bar-scrap');
const nextStepEl = document.getElementById('next-step');

// Auf dem Handy sitzt der Umschau-Button direkt in der Leiste (spart Platz)
if (isTouchDevice) {
    lookBtn.className = 'bar-btn look-in-bar hidden';
    actionBar.appendChild(lookBtn);
}

btnBarFile.addEventListener('click', () => {
    scrapModal.classList.add('hidden');
    closedFile.click();
});
function openScrapFromUi() {
    openFileModal.classList.add('hidden');
    scrapPaper.click();
}
btnBarScrap.addEventListener('click', openScrapFromUi);
document.getElementById('btn-open-scrap').addEventListener('click', openScrapFromUi);

function refreshActionBar(data, target, isSetter) {
    lastBarData = [data, target, isSetter];
    actionBar.classList.remove('hidden');
    const s1 = data.stage1 || {};
    const s2 = data.stage2 || {};
    const s3 = data.stage3 || {};
    let text = '';
    let needsScrap = false;

    if (!fileEverOpened) {
        text = 'Hebe die Akte vom Tisch auf, um das Verhör zu beginnen.';
    } else if (target === stage1) {
        text = s1[currentUserRole] ? 'Warte auf die Aussage deines Partners …' : 'Beantworte Frage 1 in der Akte.';
    } else if (target === stage2) {
        if (isSetter) {
            needsScrap = !s2.word;
            text = s2.word ? 'Notiz abgegeben. Dein Partner rät …' : `Beantworte heimlich die Alibi-Frage auf der Notiz für ${DISPLAY_NAMES[currentUserRole === 'Juls' ? 'Joe' : 'Juls']}.`;
        } else {
            needsScrap = !!s2.word && !s2.guess;
            text = s2.word ? 'Lies die Notiz und errate die Alibi-Antwort.' : 'Dein Partner schreibt dir gerade eine Notiz …';
        }
    } else if (target === stage3) {
        text = s3[currentUserRole] ? 'Warte, welchen Gegenstand dein Partner wählt …' : 'Beweise dein Alibi: Wähle in der Akte einen der 10 Gegenstände.';
    } else if (s3.Juls && s3.Joe && s3.Juls !== s3.Joe && !data.result) {
        text = '⏰ PANIK! Schickt Wörter, bis euer letztes Wort gleich ist!';
    } else {
        text = 'Das Urteil ist gefallen.';
    }
    nextStepEl.innerText = text;
    const openScrapBtn = document.getElementById('btn-open-scrap');
    openScrapBtn.classList.toggle('hidden', !needsScrap);
    openScrapBtn.innerText = isSetter ? '🗒 Notiz schreiben' : '🗒 Notiz lesen';
    btnBarScrap.classList.toggle('hidden', !(needsScrap || !scrapPaper.classList.contains('hidden')));
    btnBarScrap.classList.toggle('pulse', needsScrap);
    // Akte pulsiert, wenn man selbst als Nächstes dran ist und nichts offen ist
    const myTurnInFile = !fileEverOpened || (target === stage1 && !s1[currentUserRole]) ||
        (target === stage2 && !isSetter && s2.word && !s2.guess) ||
        (target === stage3 && !s3[currentUserRole]) ||
        (target === stageResult && s3.Juls !== s3.Joe && !data.result);
    btnBarFile.classList.toggle('pulse', !!myTurnInFile && !needsScrap);
}

// Führt die Spieler durch die Stufen: öffnet Fenster und scrollt zur aktuellen Stufe
const autoShown = {};
function guideToStage(data) {
    const setterRole = isEvenDay ? 'Juls' : 'Joe';
    const isSetter = currentUserRole === setterRole;
    const bothS1 = data.stage1 && data.stage1.Juls && data.stage1.Joe;

    // Die Notiz poppt nicht von selbst auf: Der Spieler öffnet sie über den pulsierenden Notiz-Button
    // oder indem er unter dem Tisch auf den Zettel tippt.

    let target = stage1;
    if (bothS1) target = stage2;
    if (data.stage2 && data.stage2.guess) target = stage3;
    if (data.stage3 && data.stage3.Juls && data.stage3.Joe) target = stageResult;

    // Akte als Schritt-für-Schritt-Ablauf: nur die aktuelle Stufe ist sichtbar
    [stage1, stage2, stage3, stageResult].forEach(s => s.classList.toggle('stage-off', s !== target));
    refreshActionBar(data, target, isSetter);

    if (target.id !== autoShown.stageId) {
        autoShown.stageId = target.id;
        if (target === stageResult) {
            // Urteil: Akte wird zur Verkündung wieder aufgeschlagen
            if (scrapModal.classList.contains('hidden')) openFileModal.classList.remove('hidden');
        } else if (target !== stage1) {
            // Stufe geschafft: Akte klappt zu, der Spieler hebt sie für die nächste Stufe wieder auf
            openFileModal.classList.add('hidden');
        }
    }
}

// Auswertung der Insider-Brücke (Stufe 1): persönlicher Fall = Ziel-Antwort, allgemeiner Fall = Übereinstimmung
function describeStage1(s1) {
    const j = s1.Juls, o = s1.Joe;
    let text;
    if (activeCase.type === 'personal') {
        const jOk = matchesTarget(j, activeCase.targets);
        const oOk = matchesTarget(o, activeCase.targets);
        if (jOk && oOk) text = `Insider-Brücke steht! Beide wussten es: ${activeCase.targets[0]}.`;
        else text = `Die Brücke wackelt... Juls: „${j}“, Joe: „${o}“. Gesucht war: ${activeCase.targets[0]}.`;
        stage1Outcome = jOk && oOk;
    } else {
        const same = normalizeAnswer(j) === normalizeAnswer(o);
        text = same ? `Gleiche Wellenlänge! Beide sagen: „${j}“.`
                    : `Verschiedene Wege... Juls: „${j}“, Joe: „${o}“. Aber weiter geht's.`;
        stage1Outcome = same;
    }
    // Die Kommissare reagieren und gehen kurz raus. Von der geheimen Notiz wissen sie nichts!
    sayOnce('s1react', stage1Outcome
        ? "Hm. Eure Geschichten passen erstaunlich gut zusammen. Zu gut. Wir müssen kurz telefonieren. Bleibt sitzen."
        : "Eure Aussagen weichen ab. Interessant. Wir müssen das kurz besprechen. Bleibt sitzen und rührt euch nicht.", 6000);
    if (!autoShown.s1result) {
        autoShown.s1result = true;
        playSound(stage1Outcome ? 'win' : 'creak');
    }
    return text;
}
let stage1Outcome = false;

function updateUIBasedOnState(data) {
    updateProgress(data);
    guideToStage(data);
    const setterRoleNow = isEvenDay ? 'Juls' : 'Joe';
    document.getElementById('s2-setter-wait')
        .classList.toggle('hidden', !(currentUserRole === setterRoleNow && data.stage2 && data.stage2.word && !data.stage2.guess));

    // --- STAGE 1 ---
    if (data.stage1 && data.stage1[currentUserRole]) {
        a1Input.value = data.stage1[currentUserRole];
        a1Input.disabled = true;
        btnSubmit1.disabled = true;

        // Block transition to stage 2 visually by hiding it explicitly if partner hasn't answered
        if (!data.stage1.Juls || !data.stage1.Joe) {
            status1.innerText = "Antwort übermittelt. Warte auf Partner...";
            stage2.classList.add('hidden'); // Keep stage 2 locked

            // Dynamic waiting dialogue
            const missingRole = currentUserRole === 'Juls' ? 'Joe' : 'Juls';
            sayOnce('s1wait', `Ihre Aussage ist notiert. Wir warten jetzt noch auf die Version von ${missingRole}... und dann gleichen wir das mal ab.`, 6000);
        }
    }

    if (data.stage1 && data.stage1.Juls && data.stage1.Joe) {
        status1.innerText = describeStage1(data.stage1);
        stage2.classList.remove('hidden'); // Unlock stage 2 automatically

        if (!data.stage2) {
             const setterRole = isEvenDay ? 'Juls' : 'Joe';
             if (currentUserRole === setterRole) {
                 scrapPaper.classList.remove('hidden'); // Setter sees it to write
                 gum.classList.remove('hidden');
             }
        }
    }

    // --- STAGE 2 ---
    // Der Rater kann erst tippen, wenn die Notiz da ist
    if (!(data.stage2 && data.stage2.guess)) {
        const hasWord = !!(data.stage2 && data.stage2.word);
        s2GuessInput.disabled = !hasWord;
        btnSubmit2Guess.disabled = !hasWord;
        s2GuessInput.placeholder = hasWord ? 'Dein Tipp...' : 'Warte auf die Notiz...';
    }
    if (data.stage2) {
        if (data.stage2.word && data.stage2.emoji) {
            const word = data.stage2.word;
            s2LengthHint.innerText = word.replace(/./g, '_ ').trim();
            document.getElementById('s2-letter-hint').innerText = `${word.length} Buchstaben: ${s2LengthHint.innerText}`;

            const scrapHint = document.getElementById('s2-emoji-hint');
            if(scrapHint) scrapHint.innerText = data.stage2.emoji;

            const setterRole = isEvenDay ? 'Juls' : 'Joe';

            if (currentUserRole !== setterRole) {
                scrapPaper.classList.remove('hidden');
                gum.classList.remove('hidden');
            } else {
                 btnSubmit2Set.disabled = true;
                 s2WordInput.disabled = true;
                 s2EmojiInput.disabled = true;
            }
        }

        if (data.stage2.guess) {
            if (s2GuesserView.classList.contains('hidden') === false) {
                s2GuessInput.value = data.stage2.guess;
                s2GuessInput.disabled = true;
                btnSubmit2Guess.disabled = true;
            }
            // Alibi-Check: Hat der Partner die Antwort auf der Notiz erraten?
            if (data.stage2.word) {
                status2.innerText = normalizeAnswer(data.stage2.guess) === normalizeAnswer(data.stage2.word)
                    ? `✔ Alibi bestätigt: „${data.stage2.word}“`
                    : `✘ Alibi wackelt: geraten „${data.stage2.guess}“, gemeint war „${data.stage2.word}“`;
            }
            stage3.classList.remove('hidden');
            // Die beschlagnahmten Tascheninhalte liegen jetzt auf dem Tisch
            tableItems.classList.remove('hidden');

            if (!data.stage3 || (!data.stage3.Juls || !data.stage3.Joe)) {
                const clueEl = document.getElementById('clue-text');
                if (clueEl) clueEl.innerText = activeCase.clue ? `🔍 Neues Indiz: ${activeCase.clue}` : '';
                // Die Detektive kommen zurück, vergleichen das Alibi aus der Notiz und leeren die Taschen aus
                const alibiHolds = data.stage2.word && normalizeAnswer(data.stage2.guess) === normalizeAnswer(data.stage2.word);
                const alibiLine = alibiHolds
                    ? "Euer Alibi deckt sich. Verdächtig gut. "
                    : "Euer Alibi hat Lücken. Das gefällt mir. ";
                sayOnce('s3intro', `So, da sind wir wieder. ${alibiLine}Wir haben etwas gefunden: ${activeCase.clue} Sie bestreiten die Tat? Dann beweisen Sie Ihr Alibi. Wir haben Ihre Taschen geleert, alles liegt auf dem Tisch. ${activeCase.q3}`, 12000, activeCase.speaker);
                if (alibiHolds && !spoken.s3win) { spoken.s3win = true; playSound('win'); }
            }
        }
    }

    // --- STAGE 3: DER ALIBI-BEWEIS ---
    const s3 = data.stage3 || {};
    const myItem = s3[currentUserRole];
    itemGrid.querySelectorAll('.item-card').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.item === myItem);
        btn.disabled = !!myItem;
    });
    if (myItem && (!s3.Juls || !s3.Joe)) {
        status3.innerText = `Du hast gewählt: ${itemLabel(myItem)}. Warte auf deinen Partner...`;
        stageResult.classList.add('hidden');
        const missingRole = currentUserRole === 'Juls' ? 'Joe' : 'Juls';
        sayOnce('s3wait', `Notiert. Mal sehen, ob ${missingRole} dieselbe Geschichte erzählt.`, 5000);
    }

    if (s3.Juls && s3.Joe) {
        status3.innerText = "Beide haben ausgesagt!";
        stageResult.classList.remove('hidden');
        evaluateFinal(data);
    }
}

// Level 3: Gegenstand anklicken
function chooseAlibiItem(itemId) {
    if (itemGrid.querySelector('.item-card.selected')) return; // schon gewählt
    itemGrid.querySelectorAll('.item-card').forEach(btn => {
        btn.disabled = true;
        btn.classList.toggle('selected', btn.dataset.item === itemId);
    });
    status3.innerText = "Sende Aussage...";
    playSound('stamp');
    closeFileSoon();

    // Zeitpunkt zuerst speichern: Daraus berechnen beide Geräte denselben Panik-Countdown
    updateWithTimeout(ref(db, `daily/${currentDayStr}/stage3At`), { [currentUserRole]: Date.now() })
        .then(() => updateWithTimeout(ref(db, `daily/${currentDayStr}/stage3`), { [currentUserRole]: itemId }))
        .catch(err => handleFirebaseError(err, () => {
            itemGrid.querySelectorAll('.item-card').forEach(btn => { btn.disabled = false; btn.classList.remove('selected'); });
            status3.innerText = "";
        }));
}

// Helper for Firebase error handling
function handleFirebaseError(err, reEnableFunc) {
    console.error("Firebase update error", err);
    alert("Die Verbindung zum Server ist fehlgeschlagen. Prüfe deine Internetverbindung und die Firebase-Regeln (Realtime Database muss Lesen/Schreiben erlauben). Versuche es erneut.");
    if (reEnableFunc) reEnableFunc();
}

// Helper for timeout Firebase calls
function updateWithTimeout(refPath, dataObj, timeoutMs = 3000) {
    return Promise.race([
        update(refPath, dataObj),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout: Keine Verbindung zur Datenbank.")), timeoutMs))
    ]);
}

// Stage 1 Submit
btnSubmit1.addEventListener('click', () => {
    const val = a1Input.value.trim();
    if (!val) return;

    a1Input.disabled = true;
    btnSubmit1.disabled = true;
    status1.innerText = "Sende Daten...";
    playSound('stamp');
    closeFileSoon();

    updateWithTimeout(ref(db, `daily/${currentDayStr}/stage1`), {
        [currentUserRole]: val
    }).catch(err => handleFirebaseError(err, () => {
        a1Input.disabled = false;
        btnSubmit1.disabled = false;
        status1.innerText = "";
    }));
});

// Stage 2 Submit Setter
btnSubmit2Set.addEventListener('click', () => {
    const word = s2WordInput.value.trim();
    const emoji = s2EmojiInput.value.trim();
    if (!word || !emoji) return;

    s2WordInput.disabled = true;
    s2EmojiInput.disabled = true;
    btnSubmit2Set.disabled = true;
    playSound('stamp');

    updateWithTimeout(ref(db, `daily/${currentDayStr}/stage2`), {
        word: word,
        emoji: emoji
    }).then(() => {
        scrapModal.classList.add('hidden');
        // Absichtlich kein Detektiv-Kommentar: Die Notiz ist geheim
    }).catch(err => handleFirebaseError(err, () => {
        s2WordInput.disabled = false;
        s2EmojiInput.disabled = false;
        btnSubmit2Set.disabled = false;
    }));
});

// Stage 2 Submit Guesser
btnSubmit2Guess.addEventListener('click', () => {
    const guess = s2GuessInput.value.trim();
    if (!guess) return;

    s2GuessInput.disabled = true;
    btnSubmit2Guess.disabled = true;
    playSound('stamp');
    closeFileSoon();

    updateWithTimeout(ref(db, `daily/${currentDayStr}/stage2`), {
        guess: guess
    }).catch(err => handleFirebaseError(err, () => {
        s2GuessInput.disabled = false;
        btnSubmit2Guess.disabled = false;
    }));
});

// --- EVALUATION (Level 3) & LEVEL 4: DIE 1-MINUTEN-PANIK ---
const PANIC_SECONDS = 60;
const PANIC_LEAD_MS = 4000; // kurze Alarm-Phase, bevor der Countdown losläuft
let panicInterval = null;
let lastPanicData = null;
let lastTickSecond = null;

// Beide Geräte rechnen denselben Countdown aus: ab der späteren der beiden Aussagen aus Level 3
function panicTimes(data) {
    const at = data.stage3At || {};
    const base = Math.max(at.Juls || 0, at.Joe || 0) || Date.now();
    const start = base + PANIC_LEAD_MS;
    return { start, end: start + PANIC_SECONDS * 1000 };
}

function lastWord(data, role) {
    const entry = data.panic && data.panic[role];
    return entry && entry.word ? entry.word : '';
}

function panicIsMatch(data) {
    const a = normalizeAnswer(lastWord(data, 'Juls'));
    const b = normalizeAnswer(lastWord(data, 'Joe'));
    return a.length > 0 && a === b;
}

function evaluateFinal(data) {
    resJuls.innerText = itemLabel(data.stage3.Juls);
    resJoe.innerText = itemLabel(data.stage3.Joe);

    // Level 3 geschafft: beide haben denselben Gegenstand gewählt
    if (data.stage3.Juls === data.stage3.Joe) {
        finishGame(data, true, 'alibi');
        return;
    }

    // Aussage geplatzt -> Level 4
    lastPanicData = data;
    if (data.result === 'win') { finishGame(data, true, 'panic'); return; }
    if (data.result === 'lose') { finishGame(data, false, 'panic'); return; }
    if (panicIsMatch(data)) {
        updateWithTimeout(ref(db, `daily/${currentDayStr}`), { result: 'win' }).catch(() => {});
        finishGame(data, true, 'panic');
        return;
    }
    runPanic(data);
}

function runPanic(data) {
    document.getElementById('result-title').innerText = 'ROTER ALARM: Die Aussage ist geplatzt!';
    panicSection.classList.remove('hidden');
    panicHud.classList.remove('hidden');
    document.body.classList.add('panic-mode');

    if (autoShown.final !== 'alarm') {
        autoShown.final = 'alarm';
        playSound('alarm');
        shakeScreen();
        speak("ROTER ALARM! Eure Geschichten passen nicht zusammen! Ihr habt eine Minute. Sagt beide dasselbe – oder ab in die Zelle!", 6000, 'grimm');
    }

    // Partnerwörter und eigene Wörter anzeigen
    const partner = currentUserRole === 'Juls' ? 'Joe' : 'Juls';
    panicPartnerLabel.innerText = `${DISPLAY_NAMES[partner]}s letztes Wort`;
    panicMine.innerText = lastWord(data, currentUserRole) || '–';
    panicTheirs.innerText = lastWord(data, partner) || '–';
    renderPanicLog(data);

    if (!panicInterval) {
        panicInterval = setInterval(panicTick, 250);
        panicTick();
    }
}

function renderPanicLog(data) {
    const log = (data.panic && data.panic.log) ? Object.entries(data.panic.log) : [];
    log.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0) || a[0].localeCompare(b[0]));
    const known = panicLog.childElementCount;
    if (log.length === known) return;
    panicLog.innerHTML = '';
    log.forEach(([, e]) => {
        const line = document.createElement('div');
        line.className = `panic-msg ${e.role === currentUserRole ? 'mine' : 'theirs'}`;
        line.innerHTML = `<span class="who"></span><span class="word"></span>`;
        line.querySelector('.who').textContent = e.role === currentUserRole ? 'Du' : DISPLAY_NAMES[e.role];
        line.querySelector('.word').textContent = e.word;
        panicLog.appendChild(line);
    });
    panicLog.scrollTop = panicLog.scrollHeight;
    // Neues Wort vom Partner: kurzer Ton
    const newest = log[log.length - 1];
    if (log.length > known && newest && newest[1].role !== currentUserRole) playSound('pop');

    // Die Detektive haken nach, wenn beide ein Wort haben, die Wörter aber nicht zusammenpassen
    // (beim ersten Laden der Seite nicht, sonst würden alte Wörter erneut kommentiert)
    if (panicLogSeen !== null && log.length > panicLogSeen) doubtIfMismatch(data);
    panicLogSeen = log.length;
}

let panicLogSeen = null;
let lastDoubtAt = 0;
let lastDoubtIndex = -1;
const DOUBT_LINES = [
    "Das hat so nicht ganz gestimmt. Sind Sie sich sicher?",
    "Hmm. Zwei verschiedene Wörter. Sind Sie sich da wirklich sicher?",
    "Das klingt nicht nach derselben Geschichte. Überlegen Sie noch einmal.",
    "Ihre Wörter passen nicht zusammen. Sicher, dass Sie die Wahrheit sagen?",
    "Aha. Der eine sagt so, der andere so. Sind Sie sich sicher?"
];
function doubtIfMismatch(data) {
    const a = normalizeAnswer(lastWord(data, 'Juls'));
    const b = normalizeAnswer(lastWord(data, 'Joe'));
    if (!a || !b || a === b) return;                         // noch kein Vergleich möglich oder schon gleich
    if (data.result) return;                                  // Spiel ist vorbei
    if (Date.now() - lastDoubtAt < 6000) return;              // nicht bei jedem Wort, sonst nervt es
    lastDoubtAt = Date.now();
    let idx;
    do { idx = Math.floor(Math.random() * DOUBT_LINES.length); } while (idx === lastDoubtIndex && DOUBT_LINES.length > 1);
    lastDoubtIndex = idx;
    speak(DOUBT_LINES[idx], 3500);
}

function panicTick() {
    if (!lastPanicData) return;
    const { start, end } = panicTimes(lastPanicData);
    const now = Date.now();
    const secondsLeft = Math.max(0, Math.ceil((end - Math.max(now, start)) / 1000));
    panicSecondsEl.innerText = secondsLeft;
    panicHudSeconds.innerText = secondsLeft;
    panicHud.classList.toggle('urgent', secondsLeft <= 10);

    const running = now >= start && now < end;
    panicInput.disabled = !running;
    btnPanicSend.disabled = !running;
    if (now < start) panicInput.placeholder = 'Gleich geht\'s los...';
    else if (running) panicInput.placeholder = 'Wort eintippen + Enter';

    // Ticken jede Sekunde, in den letzten 10 Sekunden doppelt
    if (running && secondsLeft !== lastTickSecond) {
        lastTickSecond = secondsLeft;
        playSound(secondsLeft % 2 ? 'tick' : 'tock');
        if (secondsLeft <= 10) setTimeout(() => playSound('tick'), 250);
    }

    // Zeit abgelaufen ohne Übereinstimmung -> Knast
    if (now >= end && !panicIsMatch(lastPanicData)) {
        updateWithTimeout(ref(db, `daily/${currentDayStr}`), { result: 'lose' }).catch(() => {});
        finishGame(lastPanicData, false, 'panic');
    }
}

function stopPanic() {
    clearInterval(panicInterval);
    panicInterval = null;
    document.body.classList.remove('panic-mode');
    panicHud.classList.add('hidden');
    panicInput.disabled = true;
    btnPanicSend.disabled = true;
}

// Level 4: Wort absenden (unbegrenzt oft)
btnPanicSend.addEventListener('click', () => {
    const word = panicInput.value.trim();
    if (!word || btnPanicSend.disabled) return;
    const ts = Date.now();
    panicInput.value = '';
    panicInput.focus();
    playSound('typewriter');
    panicMine.innerText = word;

    const base = `daily/${currentDayStr}/panic`;
    Promise.all([
        updateWithTimeout(ref(db, base), { [currentUserRole]: { word, ts } }),
        updateWithTimeout(ref(db, `${base}/log`), { [`${ts}_${currentUserRole}`]: { role: currentUserRole, word, ts } })
    ]).catch(err => console.warn('Wort konnte nicht gesendet werden', err));
});

async function restartToday() {
    // Nur den heutigen Spieltag löschen; Fälle und Streak bleiben erhalten.
    // Im Server-Modus gilt das für alle Geräte, die anderen laden sich dann von selbst neu.
    try { await set(ref(db, `daily/${currentDayStr}`), null); } catch (e) {}
    location.reload();
}

// Großer Knopf unter dem Ergebnis (der kleine in der Kopfzeile ist am Handy schwer zu treffen)
function addNewGameButton() {
    const btn = document.createElement('button');
    btn.className = 'btn-typewriter new-game-btn';
    btn.textContent = '↺ Neues Verhör starten';
    btn.addEventListener('click', restartToday);
    finalVerdict.appendChild(btn);
}

function finishGame(data, won, how) {
    stopPanic();
    panicSection.classList.toggle('hidden', how !== 'panic');
    const titleEl = document.getElementById('result-title');

    if (won) {
        titleEl.innerText = how === 'alibi' ? 'Das Alibi ist wasserdicht!' : 'Gerade noch mal davongekommen!';
        finalVerdict.innerHTML = "<h2 style='color: green;'>FREIHEIT! Das Doppel-J-Syndikat ist frei.</h2>";
        addNewGameButton();
        if (autoShown.final !== 'win') {
            autoShown.final = 'win';
            playSound('win');
            showVerdictStamp('FREIHEIT!', 'win');
            speak(how === 'alibi'
                ? "Hm. Beide derselbe Gegenstand. Ihr Alibi ist wasserdicht. Sie können gehen... für heute."
                : "Tsk. Im letzten Moment dieselbe Geschichte. Na gut. Verschwinden Sie.", 6000, how === 'alibi' ? 'schatten' : 'grimm');
        }
        if (!data.scoreProcessed) {
            processWin();
            update(ref(db, `daily/${currentDayStr}`), { scoreProcessed: true });
        }
    } else {
        titleEl.innerText = 'Die Minute ist um!';
        finalVerdict.innerHTML = "<h2 style='color: red;'>VERHAFTET! Ab in den Knast.</h2>";
        addNewGameButton();
        if (autoShown.final !== 'lose') {
            autoShown.final = 'lose';
            playSound('lose');
            showVerdictStamp('VERHAFTET!', 'lose');
            shakeScreen();
            speak("Die Zeit ist um. Ihre Geschichten passen nicht zusammen. Abführen!", 6000, 'grimm');
        }
        if (!data.scoreProcessed) {
            processLoss();
            update(ref(db, `daily/${currentDayStr}`), { scoreProcessed: true });
        }
    }
}

// --- STREAK & RANKS ---
async function loadStats() {
    const statsRef = ref(db, `stats`);
    onValue(statsRef, (snapshot) => {
        const data = snapshot.val() || { streak: 0 };
        streakCountSpan.innerText = data.streak;
        gangsterRankSpan.innerText = getRank(data.streak);
    });
}

async function processWin() {
    try {
        const statsRef = ref(db, `stats`);
        const snap = await Promise.race([get(statsRef), new Promise((_, r) => setTimeout(r, 2000))]);

        if (snap && snap.val() && snap.val().lastWin === currentDayStr) {
            return; // Already processed today
        }

        let streak = (snap && snap.val() && snap.val().streak) ? snap.val().streak : 0;
        streak++;
        set(statsRef, { streak, lastWin: currentDayStr });
    } catch(e) {} // fail silently if db doesn't work
}

async function processLoss() {
    try {
        const statsRef = ref(db, `stats`);
        const snap = await Promise.race([get(statsRef), new Promise((_, r) => setTimeout(r, 2000))]);

        if (snap && snap.val() && snap.val().lastLoss === currentDayStr) {
            return; // Already processed today
        }

        set(statsRef, { streak: 0, lastLoss: currentDayStr });
    } catch(e) {}
}

const ranks = [
    { min: 0, title: "Kaugummi-Dieb" },
    { min: 3, title: "Taschendieb" },
    { min: 7, title: "Safe-Knacker" },
    { min: 14, title: "Syndikat-Boss" },
    { min: 30, title: "Phantom von Berlin" }
];

function getRank(streak) {
    let currentTitle = ranks[0].title;
    for (let r of ranks) {
        if (streak >= r.min) currentTitle = r.title;
    }
    return currentTitle;
}

// --- HIDDEN SMUGGLE LOGIC ---
let clickCount = 0;
hiddenSmuggleBtn.addEventListener('click', () => {
    clickCount++;
    if (clickCount >= 5) {
        clickCount = 0;
        showScreen('smuggle');
    }
});

btnSmuggleBack.addEventListener('click', () => {
    showScreen('game');
});

btnSmuggleSave.addEventListener('click', async () => {
    const t = newCaseTitle.value.trim();
    const q1 = newQ1.value.trim();
    const q3 = newQ3.value.trim();
    if (!t || !q1 || !q3) return;

    try {
        // Find next available case ID (simple logic)
        const casesRef = ref(db, 'cases');
        const snap = await Promise.race([
            get(casesRef),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000))
        ]);
        const ids = snap.exists() ? Object.keys(snap.val()).map(k => parseInt(k.replace('case_', ''), 10) || 0) : [];
        const newId = Math.max(0, ...ids) + 1;

        await updateWithTimeout(ref(db, `cases/case_${newId}`), {
            title: t,
            desc: "Ein anonymer Hinweis ist eingegangen. Ermittlung läuft...",
            q1: q1,
            q3: q3
        }, 4000);

        alert("Akte erfolgreich in die Beweismittelkammer geschmuggelt!");
        newCaseTitle.value = '';
        newQ1.value = '';
        newQ3.value = '';
    } catch (err) {
        handleFirebaseError(err);
    }
});

// Run Init
init();
