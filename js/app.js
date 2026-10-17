import { db, ref, set, get, onValue, update } from './firebase-config.js';

// --- CONFIG & STATE ---
const PIN_CODE = "1337"; // Example PIN
let currentUserRole = null; // 'Juls' or 'Joe'
let currentDayStr = new Date().toISOString().split('T')[0]; // e.g., '2023-10-27'
let isEvenDay = new Date().getDate() % 2 === 0; // Defines role swap for Stage 2
let isMuted = false;

// --- SOUNDS (Synthesized for self-containment) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, type, duration, vol) {
    if (isMuted || audioCtx.state === 'suspended') return;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

    gainNode.gain.setValueAtTime(vol, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);

    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}

function playSound(soundType) {
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    if (soundType === 'typewriter') {
        // Quick sharp click
        playTone(600 + Math.random() * 200, 'square', 0.05, 0.1);
    } else if (soundType === 'stamp') {
        // Deep thud
        playTone(100, 'sine', 0.2, 0.5);
        setTimeout(() => playTone(80, 'square', 0.1, 0.3), 50);
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
        gainNode.connect(audioCtx.destination);
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

// --- INTERACTION LOGIC ---
// Resume AudioContext on first interaction
document.body.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}, { once: true });

// --- PANNING LOGIC ---
// Move the scene based on mouse position to create a first-person looking effect
function handleMouseMove(e) {
    // Only apply panning if we are in the game screen (intro is done)
    if (!screens.game.classList.contains('active')) return;

    // Clamp coordinates to ensure we don't move past the bounds and show black edges
    // The scene is initialized at left: -10vw and top: -25vh.
    // Width is 120vw (so we can move between 0 and -20vw).
    // Height is 150vh (so we can move between +25vh and -25vh relative to its center, or 0 to -50vh total).

    let x = e.clientX / window.innerWidth; // 0 to 1
    let y = e.clientY / window.innerHeight; // 0 to 1

    // Smooth boundary logic: only pan up to max limits
    const moveX = Math.max(-20, Math.min(0, x * -20));
    const moveY = Math.max(-50, Math.min(0, y * -50));

    sceneContainer.style.transform = `translate(${moveX}vw, ${moveY}vh)`;
}

window.addEventListener('mousemove', handleMouseMove);

// --- MODAL LOGIC ---
closedFile.addEventListener('click', () => {
    // Do not allow clicking if the game screen hasn't formally started
    if (!screens.game.classList.contains('active')) return;

    playSound('stamp'); // Placeholder for open sound
    openFileModal.classList.remove('hidden');
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

            // Remove intro zoom, pulling the player to the table
            sceneContainer.classList.remove('intro-view');

            listenToGameState();
            loadStats();

            // Start dialogue
            speak("Setzt euch. Wir haben einige Fragen an euch...", 4000);
        }, 500); // short wait to let UI fade out before panning into table
    });
});


// --- GAME LOGIC ---

// --- DIALOG SYSTEM ---
let currentDialogInterval;

function speak(text, duration = 5000) {
    clearInterval(currentDialogInterval);
    dialogText.innerText = '';

    let i = 0;
    currentDialogInterval = setInterval(() => {
        dialogText.innerText += text.charAt(i);
        if (text.charAt(i).trim() !== '') playSound('typewriter');
        i++;
        if (i >= text.length) {
            clearInterval(currentDialogInterval);
            setTimeout(() => {
                dialogText.innerText = '';
            }, duration);
        }
    }, 50);
}

// --- GAME LOGIC ---

const hardcodedCases = [
    { title: "Der Schmuggel an der Ostsee", desc: "Wir haben Berichte über Schmuggelware an der Küste. Sie behaupten, Sie waren dort nur für Ihren Urlaub.", q1: "Wenn das stimmt: Wie heißt der genaue Ort an der Ostsee?", q3: "Wo war die Schmuggelware wirklich versteckt?" },
    { title: "Lärmbelästigung oder Bandenkrieg?", desc: "Die Nachbarn haben extreme Schreie aus Ihrer Wohnung gemeldet. Sie schieben es auf ein Videospiel.", q1: "Welches Spiel hat Sie angeblich so ausrasten lassen?", q3: "Wer hat im Spiel eigentlich den Fehler gemacht?" },
    { title: "Der auffällige Flucht-Unfall", desc: "Am Tatort wurden seltsame Schleifspuren gefunden. Sie behaupten, Joe hätte sich einfach mal wieder das Knie gebrochen.", q1: "Womit genau ist sie damals angeblich verunglückt?", q3: "Wer hat die Ambulanz gerufen?" },
    { title: "Die abgehörte Funkfrequenz", desc: "Wir haben Ihren Funkverkehr abgehört. Jemand rief panisch: 'Schnell, steig auf, Bebi Maus!'", q1: "Womit genau sind Sie beide danach in die Nacht geflüchtet?", q3: "Wer saß am Steuer?" },
    { title: "Die tierische Sabotage", desc: "Die Überwachungskameras wurden von einem Tier sabotiert, das Sie heimlich trainiert haben.", q1: "Welches Tier haben Sie durch den Lüftungsschacht geschickt?", q3: "Welche Belohnung hat das Tier danach bekommen?" },
    { title: "Das unauffällige Fast-Food", desc: "Sie behaupten, Sie waren zur Tatzeit in einem Drive-in. Wir haben den Wagen durchsucht.", q1: "Welches Fast-Food-Gericht lag angeblich noch auf dem Beifahrersitz?", q3: "Welches Getränk war im Getränkehalter?" },
    { title: "Der Haushalts-Ausbruch", desc: "Jemand hat das Schloss zur Tresorkammer mit einem völlig ungeeigneten Gegenstand aus der Küche geknackt.", q1: "Was haben Sie als Werkzeug zweckentfremdet?", q3: "Wer von Ihnen hat das Schloss geknackt?" },
    { title: "Der falsche Deckname", desc: "Ein Zeuge hat gehört, wie Sie Ihren Komplizen bei der Flucht mit dem Namen eines Charakters aus einer Serie gerufen haben.", q1: "Welcher Name aus Ihrer gemeinsamen Lieblingsserie war das?", q3: "Welchen Decknamen hatte der Fahrer?" }
];

async function loadDailyCase() {
    let totalCases = 30; // fallback minimum
    let activeCase = hardcodedCases[0]; // absolute fallback

    try {
        // Implement a timeout to prevent hanging on placeholder credentials
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase timeout')), 3000));

        // First, determine how many cases are actually in the DB to support smuggled cases
        const casesRef = ref(db, 'cases');
        const casesSnapshot = await Promise.race([get(casesRef), timeoutPromise]);

        if (casesSnapshot.exists()) {
            totalCases = Math.max(hardcodedCases.length, Object.keys(casesSnapshot.val()).length);
        } else {
            totalCases = hardcodedCases.length;
        }

        // Determine which case to load based on day of year to rotate through ALL cases
        const now = new Date();
        const start = new Date(now.getFullYear(), 0, 0);
        const diff = now - start;
        const oneDay = 1000 * 60 * 60 * 24;
        const dayOfYear = Math.floor(diff / oneDay);

        const caseIndex = (dayOfYear % totalCases);

        // Try to load from DB first
        const caseRef = ref(db, `cases/case_${caseIndex + 1}`);
        let snapshot = await Promise.race([get(caseRef), timeoutPromise]);

        if (snapshot.exists()) {
            activeCase = snapshot.val();
        } else {
            const fallbackIndex = caseIndex % hardcodedCases.length;
            activeCase = hardcodedCases[fallbackIndex];
        }
    } catch (e) {
        // If Firebase get fails (e.g. placeholder config), fallback gracefully
        console.warn("Could not load from Firebase. Using local hardcoded case.", e);
        const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
        const fallbackIndex = dayOfYear % hardcodedCases.length;
        activeCase = hardcodedCases[fallbackIndex];
    }

    // Populate Modal File
    caseName.innerText = activeCase.title;
    q1Text.innerText = activeCase.q1;
    q3Text.innerText = activeCase.q3;

    // Populate Cover (Table)
    coverCaseTitle.innerText = activeCase.title;
    coverCaseDesc.innerText = activeCase.desc || "Ermittlung läuft...";
    coverQ1.innerText = "Frage 1: " + activeCase.q1;

    setupStage2Roles();
}

function setupStage2Roles() {
    const setterRole = isEvenDay ? 'Juls' : 'Joe';
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

function updateUIBasedOnState(data) {
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
            speak(`Ihre Aussage ist notiert. Wir warten jetzt noch auf die Version von ${missingRole}... und dann gleichen wir das mal ab.`, 6000);
        }
    }

    if (data.stage1 && data.stage1.Juls && data.stage1.Joe) {
        status1.innerText = "Beide Antworten liegen vor!";
        stage2.classList.remove('hidden'); // Unlock stage 2 automatically

        if (!data.stage2) {
             const setterRole = isEvenDay ? 'Juls' : 'Joe';
             if (currentUserRole === setterRole) {
                 speak(`Interessant... ${currentUserRole}, kleben Sie mir jetzt heimlich einen Kassiber unter den Tisch. Emojis!`, 6000);
                 scrapPaper.classList.remove('hidden'); // Setter sees it to write
                 gum.classList.remove('hidden');
             } else {
                 speak("Wir prüfen das. Einer von euch verhält sich nervös...", 4000);
             }
        }
    }

    // --- STAGE 2 ---
    if (data.stage2) {
        if (data.stage2.word && data.stage2.emoji) {
            const word = data.stage2.word;
            s2LengthHint.innerText = word.replace(/./g, '_ ').trim();

            const scrapHint = document.getElementById('s2-emoji-hint');
            if(scrapHint) scrapHint.innerText = data.stage2.emoji;

            const setterRole = isEvenDay ? 'Juls' : 'Joe';

            if (currentUserRole !== setterRole) {
                scrapPaper.classList.remove('hidden');
                gum.classList.remove('hidden');
                if (!data.stage2.guess) {
                    speak("Ich habe ein Rascheln gehört. Schauen Sie mal unter den Tisch!", 5000);
                }
            } else {
                 btnSubmit2Set.disabled = true;
                 s2WordInput.disabled = true;
                 s2EmojiInput.disabled = true;
                 if (!data.stage2.guess) {
                    speak("Zettel klebt. Verraten Sie sich nicht durch Blicke.", 4000);
                 }
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

            if (!data.stage3 || (!data.stage3.Juls || !data.stage3.Joe)) {
                speak("Genug getuschelt! Beantworten Sie mir nun die finale Frage getrennt voneinander.", 6000);
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
            speak(`Mal sehen, ob Ihr Komplize ${missingRole} gleich dieselbe Geschichte erzählt. Wir warten.`, 6000);
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
    alert("Die Verbindung zum Server ist fehlgeschlagen (Hast du deine Firebase Config eingetragen?). Versuche es erneut.");
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
    const ansJuls = data.stage3.Juls.toLowerCase();
    const ansJoe = data.stage3.Joe.toLowerCase();

    resJuls.innerText = data.stage3.Juls;
    resJoe.innerText = data.stage3.Joe;

    const isMatch = ansJuls === ansJoe;
    const isOverridden = data.overrideSuccess === true;
    const isRescued = data.rescueSuccess === true;

    if (isMatch || isOverridden || isRescued) {
        finalVerdict.innerHTML = "<h2 style='color: green;'>FREIHEIT! Akte geschlossen.</h2>";
        redAlertSection.classList.add('hidden');
        btnAlibiOverride.classList.add('hidden');

        speak("Ihre Aussagen decken sich. Sie können gehen... für heute.", 6000);

        if (!data.scoreProcessed) {
            processWin();
            update(ref(db, `daily/${currentDayStr}`), { scoreProcessed: true });
        }
    } else {
        // Mismatch
        finalVerdict.innerHTML = "";
        redAlertSection.classList.remove('hidden');
        btnAlibiOverride.classList.remove('hidden');
        playSound('creak');

        if (!data.rescueSuccess && !data.overrideSuccess) {
             speak("ROTER ALARM! Ihre Aussagen widersprechen sich! Ein Wort rettet Sie vielleicht noch...", 6000);
        }

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
