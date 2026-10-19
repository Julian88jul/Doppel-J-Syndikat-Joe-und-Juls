import { db, ref, set, get, onValue, update, isLocalMode } from './firebase-config.js';

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
const a3Input = document.getElementById('a3-input');
const btnSubmit3 = document.getElementById('btn-submit-3');
const status3 = document.getElementById('status-3');

const dialogSystem = document.getElementById('dialog-system');
const dialogText = document.getElementById('dialog-text');

const resJuls = document.getElementById('res-juls');
const resJoe = document.getElementById('res-joe');
const redAlertSection = document.getElementById('red-alert-section');
const rescueInput = document.getElementById('rescue-input');
const btnRescue = document.getElementById('btn-rescue');
const finalVerdict = document.getElementById('final-verdict');
const btnAlibiOverride = document.getElementById('btn-alibi-override');

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

    if (isLocalMode) {
        const resetBtn = document.getElementById('reset-btn');
        resetBtn.classList.remove('hidden');
        resetBtn.addEventListener('click', () => {
            // Nur heutige Spieldaten löschen; Fälle und Streak bleiben erhalten
            const key = 'djs_local_db';
            try {
                const dbData = JSON.parse(localStorage.getItem(key)) || {};
                if (dbData.daily) delete dbData.daily[currentDayStr];
                localStorage.setItem(key, JSON.stringify(dbData));
            } catch (e) {}
            location.reload();
        });

        const banner = document.createElement('div');
        banner.className = 'local-banner';
        banner.innerText = 'Lokaler Modus: Firebase ist nicht eingerichtet, Spielstände bleiben in diesem Browser.';
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
    'a3-input': btnSubmit3,
    'rescue-input': btnRescue
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
const CASES_VERSION = 2;
const hardcodedCases = [
    { id: 'case_1', type: 'personal', speaker: 'grimm', title: "Der Schmuggel an der Ostsee",
      desc: "Wir haben Berichte über Schmuggelware an der Küste. Sie behaupten, Sie waren dort nur für Ihren einzigen gemeinsamen Urlaub.",
      q1: "Wenn das stimmt: Wie heißt der genaue Ort an der Ostsee?", q3: "Wo war die Schmuggelware wirklich versteckt?", targets: ["Scharbeutz"] },
    { id: 'case_2', type: 'personal', speaker: 'schatten', title: "Lärmbelästigung oder Bandenkrieg?",
      desc: "Die Nachbarn haben extreme Schreie aus Ihrer Wohnung gemeldet. Sie schieben es auf ein harmloses Videospiel.",
      q1: "Welches Spiel hat Sie angeblich so ausrasten lassen?", q3: "Wer hat im Spiel eigentlich den Fehler gemacht?", targets: ["Brawl Stars"] },
    { id: 'case_3', type: 'personal', speaker: 'grimm', title: "Der auffällige Flucht-Unfall",
      desc: "Am Tatort wurden seltsame Schleifspuren gefunden. Sie behaupten, Joe hätte sich einfach mal wieder das Knie gebrochen.",
      q1: "Womit genau ist sie damals angeblich verunglückt?", q3: "Wer hat die Ambulanz gerufen?", targets: ["E-Scooter", "Scooter"] },
    { id: 'case_4', type: 'personal', speaker: 'schatten', title: "Die abgehörte Funkfrequenz",
      desc: "Wir haben Ihren Funkverkehr abgehört. Jemand rief panisch: 'Schnell, steig auf, Bebi Maus!'",
      q1: "Womit genau sind Sie beide danach in die Nacht geflüchtet?", q3: "Wer saß am Steuer?", targets: ["Moped"] },
    { id: 'case_5', type: 'general', speaker: 'grimm', title: "Die tierische Sabotage",
      desc: "Die Überwachungskameras wurden von einem Tier sabotiert, das Sie heimlich trainiert haben.",
      q1: "Welches Tier haben Sie durch den Lüftungsschacht geschickt?", q3: "Welche Belohnung hat das Tier danach bekommen?" },
    { id: 'case_6', type: 'general', speaker: 'schatten', title: "Das unauffällige Fast-Food",
      desc: "Sie behaupten, Sie waren zur Tatzeit in einem Drive-in. Wir haben den Wagen durchsucht.",
      q1: "Welches Fast-Food-Gericht lag angeblich noch auf dem Beifahrersitz?", q3: "Welches Getränk war im Getränkehalter?" },
    { id: 'case_7', type: 'general', speaker: 'grimm', title: "Der Haushalts-Ausbruch",
      desc: "Jemand hat das Schloss zur Tresorkammer mit einem völlig ungeeigneten Gegenstand aus der Küche geknackt.",
      q1: "Was haben Sie als Werkzeug zweckentfremdet?", q3: "Wer von Ihnen hat das Schloss geknackt?" },
    { id: 'case_8', type: 'general', speaker: 'schatten', title: "Der falsche Deckname",
      desc: "Ein Zeuge hat gehört, wie Sie Ihren Komplizen bei der Flucht mit dem Namen eines Charakters aus Ihrer gemeinsamen Lieblingsserie gerufen haben.",
      q1: "Welcher Name war das?", q3: "Welchen Decknamen hatte der Fahrer?" }
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
    onValue(dailyRef, (snapshot) => {
        const data = snapshot.val() || {};
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
        text = s3[currentUserRole] ? 'Warte auf die finale Aussage deines Partners …' : 'Beantworte die finale Frage.';
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
        (target === stage3 && !s3[currentUserRole]);
    btnBarFile.classList.toggle('pulse', !!myTurnInFile && !needsScrap);
}

// Führt die Spieler durch die Stufen: öffnet Fenster und scrollt zur aktuellen Stufe
const autoShown = {};
function guideToStage(data) {
    const setterRole = isEvenDay ? 'Juls' : 'Joe';
    const isSetter = currentUserRole === setterRole;
    const bothS1 = data.stage1 && data.stage1.Juls && data.stage1.Joe;

    // Setter soll sofort den Kassiber schreiben, Rater soll ihn sofort sehen
    if (bothS1 && !(data.stage2 && data.stage2.word) && isSetter && !autoShown.write) {
        autoShown.write = true;
        openFileModal.classList.add('hidden');
        scrapModal.classList.remove('hidden');
    }
    if (data.stage2 && data.stage2.word && !data.stage2.guess && !isSetter && !autoShown.read) {
        autoShown.read = true;
        openFileModal.classList.add('hidden');
        scrapModal.classList.remove('hidden');
    }

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

            if (!data.stage3 || (!data.stage3.Juls || !data.stage3.Joe)) {
                const clueEl = document.getElementById('clue-text');
                if (clueEl) clueEl.innerText = activeCase.clue ? `🔍 Neues Indiz: ${activeCase.clue}` : '';
                sayOnce('s3intro', `So, da sind wir wieder. Wir haben etwas gefunden: ${activeCase.clue} Jetzt die finale Frage, getrennt voneinander: ${activeCase.q3}`, 8000, activeCase.speaker);
            }
        }
    }

    // --- STAGE 3 ---
    if (data.stage3 && data.stage3[currentUserRole]) {
        a3Input.value = data.stage3[currentUserRole];
        a3Input.disabled = true;
        btnSubmit3.disabled = true;

        // Wait for partner before showing results
        if (!data.stage3.Juls || !data.stage3.Joe) {
            status3.innerText = "Akte geschlossen. Warte auf Partner...";
            stageResult.classList.add('hidden'); // Lock results

            const missingRole = currentUserRole === 'Juls' ? 'Joe' : 'Juls';
            sayOnce('s3wait', `Mal sehen, ob Ihr Komplize ${missingRole} gleich dieselbe Geschichte erzählt. Wir warten.`, 6000);
        }
    }

    if (data.stage3 && data.stage3.Juls && data.stage3.Joe) {
        status3.innerText = "Beide Aussagen liegen vor!";
        stageResult.classList.remove('hidden'); // Automatically unlock results
        evaluateFinal(data);
    }
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

// Stage 3 Submit
btnSubmit3.addEventListener('click', () => {
    const val = a3Input.value.trim();
    if (!val) return;

    a3Input.disabled = true;
    btnSubmit3.disabled = true;
    status3.innerText = "Sende Daten...";
    playSound('stamp');
    closeFileSoon();

    updateWithTimeout(ref(db, `daily/${currentDayStr}/stage3`), {
        [currentUserRole]: val
    }).catch(err => handleFirebaseError(err, () => {
        a3Input.disabled = false;
        btnSubmit3.disabled = false;
        status3.innerText = "";
    }));
});

// --- EVALUATION ---
function evaluateFinal(data) {
    const ansJuls = normalizeAnswer(data.stage3.Juls);
    const ansJoe = normalizeAnswer(data.stage3.Joe);

    resJuls.innerText = data.stage3.Juls;
    resJoe.innerText = data.stage3.Joe;

    const isMatch = ansJuls === ansJoe;
    const isOverridden = data.overrideSuccess === true;
    const isRescued = data.rescueSuccess === true;

    if (isMatch || isOverridden || isRescued) {
        finalVerdict.innerHTML = "<h2 style='color: green;'>FREIHEIT! Akte geschlossen.</h2>";
        redAlertSection.classList.add('hidden');
        btnAlibiOverride.classList.add('hidden');

        if (autoShown.final !== 'win') {
            speak("Ihre Aussagen decken sich. Sie können gehen... für heute.", 6000);
            autoShown.final = 'win';
            playSound('win');
            showVerdictStamp('FREIHEIT!', 'win');
        }

        if (!data.scoreProcessed) {
            processWin();
            update(ref(db, `daily/${currentDayStr}`), { scoreProcessed: true });
        }
    } else {
        // Mismatch
        finalVerdict.innerHTML = "";
        redAlertSection.classList.remove('hidden');
        btnAlibiOverride.classList.remove('hidden');
        if (autoShown.final !== 'alarm') {
            autoShown.final = 'alarm';
            playSound('alarm');
            shakeScreen();
        }

        if (!data.rescueSuccess && !data.overrideSuccess) {
             sayOnce('alarmline', "ROTER ALARM! Ihre Aussagen widersprechen sich! Ein Wort rettet Sie vielleicht noch...", 6000);
        }

        // Handle rescue logic syncing
        if (data.rescue && data.rescue[currentUserRole]) {
            rescueInput.value = data.rescue[currentUserRole];
            rescueInput.disabled = true;
            btnRescue.disabled = true;
        }

        if (data.rescue && data.rescue.Juls && data.rescue.Joe) {
            const rJuls = normalizeAnswer(data.rescue.Juls);
            const rJoe = normalizeAnswer(data.rescue.Joe);
            if (rJuls === rJoe) {
                update(ref(db, `daily/${currentDayStr}`), { rescueSuccess: true });
            } else {
                finalVerdict.innerHTML = "<h2 style='color: red;'>VERHAFTET! Eure Geschichten passen nicht zusammen.</h2>";
                redAlertSection.classList.add('hidden');
                btnAlibiOverride.classList.add('hidden');
                if (autoShown.final !== 'lose') {
                    autoShown.final = 'lose';
                    playSound('lose');
                    showVerdictStamp('VERHAFTET!', 'lose');
                    shakeScreen();
                }
                if (!data.scoreProcessed) {
                    processLoss();
                    update(ref(db, `daily/${currentDayStr}`), { scoreProcessed: true });
                }
            }
        }
    }
}

// Rescue Submit
btnRescue.addEventListener('click', () => {
    const val = rescueInput.value.trim();
    if (!val) return;

    rescueInput.disabled = true;
    btnRescue.disabled = true;
    playSound('stamp');

    updateWithTimeout(ref(db, `daily/${currentDayStr}/rescue`), {
        [currentUserRole]: val
    }).catch(err => handleFirebaseError(err, () => {
        rescueInput.disabled = false;
        btnRescue.disabled = false;
    }));
});

// Alibi Override
btnAlibiOverride.addEventListener('click', () => {
    btnAlibiOverride.disabled = true;
    playSound('stamp');
    speak("Das war haarscharf am Gefängnis vorbei!", 5000);

    updateWithTimeout(ref(db, `daily/${currentDayStr}`), { overrideSuccess: true })
        .catch(err => handleFirebaseError(err, () => {
            btnAlibiOverride.disabled = false;
        }));
});

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
