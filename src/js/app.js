import { db, ref, set, get, onValue, update } from './firebase-config.js';

// --- CONFIG & STATE ---
const PIN_CODE = "1337"; // Example PIN
let currentUserRole = null; // 'Juls' or 'Joe'
let currentDayStr = new Date().toISOString().split('T')[0]; // e.g., '2023-10-27'
let isEvenDay = new Date().getDate() % 2 === 0; // Defines role swap for Stage 2
let isMuted = false;

// --- SOUNDS (Data URIs for self-containment) ---
// Note: These are very short placeholder beep/click sounds encoded as base64 audio.
// In a real app, replace with proper base64 encoded wav/mp3 of typewriter/stamp/lamp.
const sfxTypewriter = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAgACAA==");
const sfxStamp = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAgACAA==");
const sfxCreak = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAgACAA==");

function playSound(sound) {
    if (!isMuted) {
        sound.currentTime = 0;
        sound.play().catch(e => console.log("Audio play blocked by browser."));
    }
}

// --- DOM ELEMENTS ---
const screens = {
    intro: document.getElementById('screen-intro'),
    login: document.getElementById('screen-login'),
    roleSelect: document.getElementById('screen-role-select'),
    game: document.getElementById('screen-game'),
    smuggle: document.getElementById('screen-smuggle')
};

// Intro UI
const typewriterText = document.getElementById('typewriter-text');
const btnSkipIntro = document.getElementById('btn-skip-intro');

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

// Modals & Table UI
const closedFile = document.getElementById('closed-file');
const openFileModal = document.getElementById('open-file-modal');
const btnCloseFile = document.getElementById('btn-close-file');

const scrapPaper = document.getElementById('scrap-paper');
const scrapModal = document.getElementById('scrap-modal');
const btnCloseScrap = document.getElementById('btn-close-scrap');

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

const resJuls = document.getElementById('res-juls');
const resJoe = document.getElementById('res-joe');
const redAlertSection = document.getElementById('red-alert-section');
const rescueInput = document.getElementById('rescue-input');
const btnRescue = document.getElementById('btn-rescue');
const finalVerdict = document.getElementById('final-verdict');
const btnAlibiOverride = document.getElementById('btn-alibi-override');

const detectivesBg = document.querySelector('.detectives-bg');
const detectiveSpeech = document.getElementById('detective-speech');
const detectiveSpeechText = document.getElementById('detective-speech-text');

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
        input.addEventListener('input', () => playSound(sfxTypewriter));
    });

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

// --- MODAL LOGIC ---
closedFile.addEventListener('click', () => {
    playSound(sfxStamp); // Placeholder for open sound
    openFileModal.classList.remove('hidden');
});

btnCloseFile.addEventListener('click', () => {
    playSound(sfxStamp); // Placeholder for close sound
    openFileModal.classList.add('hidden');
});

scrapPaper.addEventListener('click', () => {
    playSound(sfxStamp);
    scrapModal.classList.remove('hidden');
});

btnCloseScrap.addEventListener('click', () => {
    playSound(sfxStamp);
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
        statsBoard.classList.add('hidden'); // Hide stats during intro

        // Pre-load case to get title for intro
        await loadDailyCase();

        playIntro();
    });
});

// --- INTRO SEQUENCE LOGIC ---
let introInterval;
let isIntroPlaying = false;

function playIntro() {
    showScreen('intro');
    isIntroPlaying = true;
    btnSkipIntro.classList.remove('hidden');

    const title = caseName.innerText;
    const textToType = `Doppel-J-Syndikat.\nFallakte wird geöffnet...\n\nTatvorwurf:\n${title}\n\nErmittlungen laufen. Kommissar Grimm und Detektiv Schatten haben bereits Platz genommen.\n\nBehalte die Nerven. Mach keinen Fehler.`;

    let i = 0;
    typewriterText.innerHTML = '';

    introInterval = setInterval(() => {
        if (!isIntroPlaying) return;

        typewriterText.innerHTML += textToType.charAt(i);
        // Play sound on non-whitespace
        if (textToType.charAt(i).trim() !== '') {
             playSound(sfxTypewriter);
        }

        i++;
        if (i >= textToType.length) {
            clearInterval(introInterval);
            setTimeout(endIntro, 2000);
        }
    }, 50); // Typing speed
}

function endIntro() {
    isIntroPlaying = false;
    clearInterval(introInterval);
    showScreen('game');
    statsBoard.classList.remove('hidden');
    listenToGameState();
    loadStats();
}

btnSkipIntro.addEventListener('click', endIntro);


// --- GAME LOGIC ---

async function loadDailyCase() {
    // Determine which case to load (1-30 based on day of month)
    const caseIndex = (new Date().getDate() % 30) || 30;
    const caseRef = ref(db, `cases/case_${caseIndex}`);

    let snapshot = await get(caseRef);
    if (!snapshot.exists()) {
        // Fallback case if DB is empty
        caseName.innerText = "Der verschwundene Keks";
        q1Text.innerText = "Wo warst du gestern um 20 Uhr?";
        q3Text.innerText = "Was ist das Codewort für den Safe?";
    } else {
        const data = snapshot.val();
        caseName.innerText = data.title;
        q1Text.innerText = data.q1;
        q3Text.innerText = data.q3;
    }

    setupStage2Roles();
}

function setupStage2Roles() {
    // Juls sets on even days, Joe sets on odd days
    const setterRole = isEvenDay ? 'Juls' : 'Joe';
    if (currentUserRole === setterRole) {
        s2SetterView.classList.remove('hidden');
        s2GuesserView.classList.add('hidden');
    } else {
        s2SetterView.classList.add('hidden');
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

function updateUIBasedOnState(data) {
    // --- STAGE 1 ---
    if (data.stage1 && data.stage1[currentUserRole]) {
        a1Input.value = data.stage1[currentUserRole];
        a1Input.disabled = true;
        btnSubmit1.disabled = true;
        status1.innerText = "Antwort übermittelt. Warte auf Partner...";
    }
    if (data.stage1 && data.stage1.Juls && data.stage1.Joe) {
        status1.innerText = "Beide Antworten liegen vor!";
        stage2.classList.remove('hidden');
    }

    // --- STAGE 2 ---
    if (data.stage2) {
        if (data.stage2.word && data.stage2.emoji) {
            // Setter has set the code
            const word = data.stage2.word;
            s2LengthHint.innerText = word.replace(/./g, '_ ').trim();

            // Set emoji in the scrap paper modal instead of file directly
            const scrapHint = document.getElementById('s2-emoji-hint');
            if(scrapHint) scrapHint.innerText = data.stage2.emoji;

            // Show scrap paper on table for the guesser
            if (s2SetterView.classList.contains('hidden')) {
                scrapPaper.classList.remove('hidden');
            }

            if (s2SetterView.classList.contains('hidden') === false) {
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
            status2.innerText = "Kassiber übergeben!";
            stage3.classList.remove('hidden');
        }
    }

    // --- STAGE 3 ---
    if (data.stage3 && data.stage3[currentUserRole]) {
        a3Input.value = data.stage3[currentUserRole];
        a3Input.disabled = true;
        btnSubmit3.disabled = true;
        status3.innerText = "Akte geschlossen. Warte auf Auswertung...";
    }

    if (data.stage3 && data.stage3.Juls && data.stage3.Joe) {
        stageResult.classList.remove('hidden');
        evaluateFinal(data);
    }
}

// Stage 1 Submit
btnSubmit1.addEventListener('click', () => {
    const val = a1Input.value.trim();
    if (!val) return;
    playSound(sfxStamp);
    update(ref(db, `daily/${currentDayStr}/stage1`), {
        [currentUserRole]: val
    });
});

// Stage 2 Submit Setter
btnSubmit2Set.addEventListener('click', () => {
    const word = s2WordInput.value.trim();
    const emoji = s2EmojiInput.value.trim();
    if (!word || !emoji) return;
    playSound(sfxStamp);
    update(ref(db, `daily/${currentDayStr}/stage2`), {
        word: word,
        emoji: emoji
    });
});

// Stage 2 Submit Guesser
btnSubmit2Guess.addEventListener('click', () => {
    const guess = s2GuessInput.value.trim();
    if (!guess) return;
    playSound(sfxStamp);
    update(ref(db, `daily/${currentDayStr}/stage2`), {
        guess: guess
    });
});

// Stage 3 Submit
btnSubmit3.addEventListener('click', () => {
    const val = a3Input.value.trim();
    if (!val) return;
    playSound(sfxStamp);
    update(ref(db, `daily/${currentDayStr}/stage3`), {
        [currentUserRole]: val
    });
});

// --- EVALUATION ---
function evaluateFinal(data) {
    const ansJuls = data.stage3.Juls.toLowerCase();
    const ansJoe = data.stage3.Joe.toLowerCase();

    resJuls.innerText = data.stage3.Juls;
    resJoe.innerText = data.stage3.Joe;

    const isMatch = ansJuls === ansJoe;
    const isOverridden = data.overrideSuccess === true;
    const isRescued = data.rescueSuccess === true;

    if (isMatch || isOverridden || isRescued) {
        finalVerdict.innerHTML = "<h2 style='color: green;'>FREIHEIT! Akte geschlossen.</h2>";
        detectivesBg.classList.remove('detectives-lean');
        redAlertSection.classList.add('hidden');
        btnAlibiOverride.classList.add('hidden');
        if (!data.scoreProcessed) {
            processWin();
            update(ref(db, `daily/${currentDayStr}`), { scoreProcessed: true });
        }
    } else {
        // Mismatch
        finalVerdict.innerHTML = "";
        redAlertSection.classList.remove('hidden');
        btnAlibiOverride.classList.remove('hidden');
        detectivesBg.classList.add('detectives-lean');
        playSound(sfxCreak);
        showSpeechBubble("Was haben Sie uns zu verbergen?");

        // Handle rescue logic syncing
        if (data.rescue && data.rescue[currentUserRole]) {
            rescueInput.value = data.rescue[currentUserRole];
            rescueInput.disabled = true;
            btnRescue.disabled = true;
        }

        if (data.rescue && data.rescue.Juls && data.rescue.Joe) {
            const rJuls = data.rescue.Juls.toLowerCase();
            const rJoe = data.rescue.Joe.toLowerCase();
            if (rJuls === rJoe) {
                update(ref(db, `daily/${currentDayStr}`), { rescueSuccess: true });
            } else {
                finalVerdict.innerHTML = "<h2 style='color: red;'>VERHAFTET! Eure Geschichten passen nicht zusammen.</h2>";
                redAlertSection.classList.add('hidden');
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
    playSound(sfxStamp);
    update(ref(db, `daily/${currentDayStr}/rescue`), {
        [currentUserRole]: val
    });
});

// Alibi Override
btnAlibiOverride.addEventListener('click', () => {
    playSound(sfxStamp);
    showSpeechBubble("Das war haarscharf am Gefängnis vorbei!");
    update(ref(db, `daily/${currentDayStr}`), { overrideSuccess: true });
});

function showSpeechBubble(text) {
    detectiveSpeechText.innerText = text;
    detectiveSpeech.classList.remove('hidden');
    setTimeout(() => {
        detectiveSpeech.classList.add('hidden');
    }, 5000);
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
    const statsRef = ref(db, `stats`);
    const snap = await get(statsRef);

    if (snap.val() && snap.val().lastWin === currentDayStr) {
        return; // Already processed today
    }

    let streak = (snap.val() && snap.val().streak) ? snap.val().streak : 0;
    streak++;
    set(statsRef, { streak, lastWin: currentDayStr });
}

async function processLoss() {
    const statsRef = ref(db, `stats`);
    const snap = await get(statsRef);

    if (snap.val() && snap.val().lastLoss === currentDayStr) {
        return; // Already processed today
    }

    set(statsRef, { streak: 0, lastLoss: currentDayStr });
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

    // Find next available case ID (simple logic)
    const casesRef = ref(db, 'cases');
    const snap = await get(casesRef);
    const numCases = snap.exists() ? Object.keys(snap.val()).length : 0;
    const newId = numCases + 1;

    await set(ref(db, `cases/case_${newId}`), {
        title: t,
        q1: q1,
        q3: q3
    });

    alert("Akte erfolgreich in die Beweismittelkammer geschmuggelt!");
    newCaseTitle.value = '';
    newQ1.value = '';
    newQ3.value = '';
});

// Run Init
init();