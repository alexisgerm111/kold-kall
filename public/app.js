// ════════════════════════════════════════════════════════════════════════════
//  KOLD KALL V1 — app.js
//  Flow : Login → Config → Génération persona → Briefing → Session vocale
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── État global ─────────────────────────────────────────────────────────────
const STATE = {
  user          : null,
  currentConfig : {
    type      : 'b2b',
    mode      : 'cold_call',
    subMode   : 'complet',
    canal     : 'fixe',
    difficulty: 'facile',
    secteur   : '',
    poste     : '',
    taille    : 'pme',
    produit   : ''
  },
  currentPersona   : null,   // { prenom, poste_exact, structure, ... systemBlock }
  simulationId     : null,
  conversationHistory : [],
  fullTranscription   : [],
  sessionStartTime    : null,
  timerInterval       : null,

  // Audio
  deepgramSocket  : null,
  mediaRecorder   : null,
  audioCtx        : null,
  analyser        : null,
  vizRaf          : null,
  ttsSource       : null,
  isSpeaking      : false,
};

// ─── Utilitaires ─────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');

function showScreen(id) {
  ['login-screen', 'config-screen', 'generating-screen', 'briefing-screen', 'app-screen']
    .forEach(s => {
      const el = $(s);
      if (el) el.classList.toggle('hidden', s !== id);
    });
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════════════════

// Toggle password visibility
function initPasswordToggles() {
  [['toggle-eye-login', 'login-password'], ['toggle-eye-signup', 'signup-password']].forEach(([btnId, inputId]) => {
    const btn   = $(btnId);
    const input = $(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      const isText = input.type === 'text';
      input.type = isText ? 'password' : 'text';
    });
  });
}

function initAuth() {
  initPasswordToggles();

  // Login ↔ signup
  $('btn-show-signup').addEventListener('click', () => {
    hide($('login-form'));
    show($('signup-panel'));
  });
  $('btn-show-login').addEventListener('click', () => {
    hide($('signup-panel'));
    show($('login-form'));
  });

  // Login
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn   = $('login-btn');
    const email = $('login-email').value.trim();
    const pass  = $('login-password').value;
    $('login-error').textContent = '';
    btn.disabled = true;
    btn.textContent = 'Connexion…';

    try {
      const res  = await fetch('/api/auth/login', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ email, password: pass })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur de connexion');

      STATE.user = data.user;
      const prenom = data.profile?.prenom || data.user.user_metadata?.prenom || email.split('@')[0];
      $('config-user-name').textContent = prenom;
      showScreen('config-screen');
    } catch (err) {
      $('login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Se connecter';
    }
  });

  // Signup
  $('signup-btn').addEventListener('click', async () => {
    const btn = $('signup-btn');
    $('signup-error').textContent = '';
    $('signup-success').textContent = '';
    btn.disabled = true;
    btn.textContent = 'Création…';

    try {
      const res  = await fetch('/api/auth/signup', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({
          email   : $('signup-email').value.trim(),
          password: $('signup-password').value,
          prenom  : $('signup-prenom').value.trim(),
          nom     : $('signup-nom').value.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erreur');
      $('signup-success').textContent = data.message;
    } catch (err) {
      $('signup-error').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Créer mon compte';
    }
  });

  // Mot de passe oublié
  $('btn-forgot').addEventListener('click', async () => {
    const email = $('login-email').value.trim();
    if (!email) { $('login-error').textContent = 'Entrez votre email d\'abord.'; return; }
    try {
      await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      $('login-error').style.color = 'var(--success)';
      $('login-error').textContent = 'Email de réinitialisation envoyé.';
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  // Logout
  ['btn-logout'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => {
      STATE.user = null;
      showScreen('login-screen');
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  CONFIGURATION MULTI-STEP
// ════════════════════════════════════════════════════════════════════════════

let currentStep = 1;
const TOTAL_STEPS = 4;

function updateProgress() {
  const pct = ((currentStep - 1) / (TOTAL_STEPS - 1)) * 100;
  $('config-progress-bar').style.width = `${pct}%`;
}

function showStep(n) {
  document.querySelectorAll('.config-step').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.step) === n);
  });

  const backBtn = $('btn-config-back');
  const nextBtn = $('btn-config-next');

  if (n === 1) hide(backBtn); else show(backBtn);

  if (n === TOTAL_STEPS) {
    nextBtn.innerHTML = `
      Générer le prospect
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>`;
  } else {
    nextBtn.innerHTML = `Suivant <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;
  }

  updateProgress();
  currentStep = n;
  updateConditionalSections();
}

function updateConditionalSections() {
  const { mode, type } = STATE.currentConfig;

  // Sous-mode RDV
  const rdvSection = $('rdv-submode-section');
  if (mode === 'rdv') show(rdvSection); else hide(rdvSection);

  // Canal cold call B2B
  const canalSection = $('canal-section');
  if (type === 'b2b' && mode === 'cold_call') show(canalSection); else hide(canalSection);

  // Champs B2B / B2C sur step 3
  const b2bFields = $('b2b-fields');
  const b2cFields = $('b2c-fields');
  if (b2bFields && b2cFields) {
    if (type === 'b2b') { show(b2bFields); hide(b2cFields); }
    else                { hide(b2bFields); show(b2cFields); }
  }
}

function validateStep(n) {
  if (n === 3) {
    const err = $('step3-error');
    err.textContent = '';
    if (STATE.currentConfig.type === 'b2b') {
      if (!$('input-secteur').value.trim()) { err.textContent = 'Le secteur est requis.'; return false; }
      if (!$('input-poste').value.trim())   { err.textContent = 'Le poste est requis.'; return false; }
    } else {
      if (!$('input-profil-b2c').value.trim()) { err.textContent = 'Décris le profil du particulier.'; return false; }
    }
  }
  if (n === 4) {
    const err = $('step4-error');
    err.textContent = '';
    if (!$('input-produit').value.trim()) { err.textContent = 'Décris ce que tu vends.'; return false; }
  }
  return true;
}

function collectStep3Values() {
  if (STATE.currentConfig.type === 'b2b') {
    STATE.currentConfig.secteur = $('input-secteur').value.trim();
    STATE.currentConfig.poste   = $('input-poste').value.trim();
    STATE.currentConfig.taille  = $('select-taille').value;
  } else {
    STATE.currentConfig.secteur = '';
    STATE.currentConfig.poste   = $('input-profil-b2c').value.trim();
    STATE.currentConfig.taille  = 'particulier';
  }
}

function collectStep4Values() {
  STATE.currentConfig.produit = $('input-produit').value.trim();
}

function initConfig() {
  // Option tiles — sélection
  document.querySelectorAll('.option-tile[data-group]').forEach(tile => {
    tile.addEventListener('click', () => {
      const group = tile.dataset.group;
      const value = tile.dataset.value;

      document.querySelectorAll(`.option-tile[data-group="${group}"]`).forEach(t => {
        t.classList.remove('active');
        const check = t.querySelector('.tile-check');
        if (check) hide(check);
      });
      tile.classList.add('active');
      const check = tile.querySelector('.tile-check');
      if (check) show(check);

      STATE.currentConfig[group] = value;
      updateConditionalSections();
    });
  });

  // Navigation
  $('btn-config-next').addEventListener('click', async () => {
    if (!validateStep(currentStep)) return;
    if (currentStep === 3) collectStep3Values();
    if (currentStep === 4) {
      collectStep4Values();
      await generatePersona();
      return;
    }
    showStep(currentStep + 1);
  });

  $('btn-config-back').addEventListener('click', () => {
    if (currentStep > 1) showStep(currentStep - 1);
  });

  updateProgress();
  updateConditionalSections();
}

// ════════════════════════════════════════════════════════════════════════════
//  GÉNÉRATION DE PERSONA — LLM N°1
// ════════════════════════════════════════════════════════════════════════════

const GENERATING_MESSAGES = [
  'Analyse des paramètres…',
  'Construction du profil…',
  'Génération du persona…',
  'Calibrage du comportement…',
  'Préparation de la simulation…',
];

async function generatePersona() {
  showScreen('generating-screen');

  // Animation des messages de chargement
  let msgIdx = 0;
  const subEl = $('generating-sub');
  subEl.textContent = GENERATING_MESSAGES[0];
  const msgInterval = setInterval(() => {
    msgIdx = (msgIdx + 1) % GENERATING_MESSAGES.length;
    subEl.textContent = GENERATING_MESSAGES[msgIdx];
  }, 1200);

  try {
    const res  = await fetch('/api/generate-persona', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ config: STATE.currentConfig })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur de génération');

    STATE.currentPersona = data.persona;
    clearInterval(msgInterval);
    showBriefing();
  } catch (err) {
    clearInterval(msgInterval);
    alert('Erreur lors de la génération du persona : ' + err.message);
    showScreen('config-screen');
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  ÉCRAN DE BRIEFING
// ════════════════════════════════════════════════════════════════════════════

function showBriefing() {
  const p = STATE.currentPersona;
  const c = STATE.currentConfig;

  // Badge
  const modeLabel  = c.mode === 'cold_call' ? 'Cold Call' : 'RDV';
  const typeLabel  = c.type === 'b2b' ? 'B2B' : 'B2C';
  const diffLabel  = { facile: 'Facile', moyen: 'Moyen', difficile: 'Difficile' }[c.difficulty];
  $('briefing-badge').textContent = `${modeLabel} · ${typeLabel} · ${diffLabel}`;

  // Identité
  $('briefing-avatar').textContent = p.prenom.charAt(0).toUpperCase();
  $('briefing-name').textContent   = `${p.prenom}, ${p.age} ans`;
  $('briefing-poste').textContent  = p.poste_exact;
  $('briefing-structure').textContent = `${p.structure} · ${p.ville}`;

  // Détails
  $('briefing-journee').textContent = p.journee_moment;
  $('briefing-rapport').textContent = p.rapport_produit;

  // Contraintes
  const list = $('briefing-contraintes');
  list.innerHTML = '';
  [p.contrainte_1, p.contrainte_2, p.contrainte_3].filter(Boolean).forEach(c => {
    const li = document.createElement('li');
    li.className = 'briefing-list-item';
    li.textContent = c;
    list.appendChild(li);
  });

  showScreen('briefing-screen');
}

function initBriefing() {
  $('btn-briefing-back').addEventListener('click', () => {
    showScreen('config-screen');
    showStep(1);
  });

  $('btn-start-session').addEventListener('click', startSession);

  $('btn-regenerate').addEventListener('click', async () => {
    await generatePersona();
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  SESSION VOCALE
// ════════════════════════════════════════════════════════════════════════════

function startSession() {
  const p = STATE.currentPersona;
  const c = STATE.currentConfig;

  // Reset état conversation
  STATE.conversationHistory = [];
  STATE.fullTranscription   = [];
  STATE.simulationId        = null;

  // Topbar session
  $('session-prospect-name').textContent = `${p.prenom} · ${p.poste_exact}`;
  const modeLabel = c.mode === 'cold_call' ? 'Cold Call' : 'RDV';
  $('session-badge-tag').textContent = `${modeLabel} · ${c.difficulty}`;

  // Conv empty
  $('conv-empty-sub').textContent = c.mode === 'cold_call'
    ? `Tu appelles ${p.prenom}. Parle pour commencer.`
    : `Ton RDV avec ${p.prenom} commence. Parle pour ouvrir.`;

  showScreen('app-screen');

  // Lancer la simulation Supabase en arrière-plan
  if (STATE.user) {
    fetch('/api/simulation/start', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        userId    : STATE.user.id,
        config    : STATE.currentConfig,
        personaData: STATE.currentPersona
      })
    })
    .then(r => r.json())
    .then(d => { if (d.simulationId) STATE.simulationId = d.simulationId; })
    .catch(() => {}); // non-bloquant
  }

  startTimer();
  resetOrbState();
}

// ─── Timer ───────────────────────────────────────────────────────────────────
function startTimer() {
  STATE.sessionStartTime = Date.now();
  clearInterval(STATE.timerInterval);
  STATE.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - STATE.sessionStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    $('session-timer').textContent = `${m}:${s}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(STATE.timerInterval);
  return STATE.sessionStartTime ? Math.floor((Date.now() - STATE.sessionStartTime) / 1000) : 0;
}

// ─── États de l'orb ──────────────────────────────────────────────────────────
function resetOrbState() { setOrbState('idle'); }

function setOrbState(state) {
  const orb   = $('orb-container');
  const wrap  = $('orb-icon-wrap');
  const label = $('status-label');

  orb.dataset.state = state;

  const icons = { mic: $('icon-mic'), wave: $('icon-wave'), loader: $('icon-loader'), sound: $('icon-sound'), error: $('icon-error') };
  Object.values(icons).forEach(el => { if (el) el.classList.add('hidden'); });

  const btnMic   = $('btn-mic');
  const discMic  = $('btn-mic-disc');
  const lblMic   = $('btn-mic-label');
  const iconDef  = $('mic-icon-default');
  const iconStop = $('mic-icon-stop');
  const btnEnd   = $('btn-end');
  const vizCanvas = $('audio-viz');

  switch (state) {
    case 'idle':
      icons.mic && show(icons.mic);
      label.textContent = 'Prêt à écouter';
      btnMic.disabled = false;
      btnMic.classList.remove('listening');
      iconDef && show(iconDef);
      iconStop && hide(iconStop);
      lblMic.textContent = 'Parler';
      vizCanvas.style.opacity = '0';
      break;
    case 'listening':
      icons.wave && show(icons.wave);
      label.textContent = 'En écoute…';
      btnMic.classList.add('listening');
      iconDef && hide(iconDef);
      iconStop && show(iconStop);
      lblMic.textContent = 'Envoyer';
      btnEnd && show(btnEnd);
      vizCanvas.style.opacity = '1';
      break;
    case 'thinking':
      icons.loader && show(icons.loader);
      label.textContent = 'Le prospect réfléchit…';
      btnMic.disabled = true;
      btnMic.classList.remove('listening');
      iconDef && show(iconDef);
      iconStop && hide(iconStop);
      lblMic.textContent = 'Parler';
      vizCanvas.style.opacity = '0';
      break;
    case 'speaking':
      icons.sound && show(icons.sound);
      label.textContent = 'Le prospect parle…';
      btnMic.disabled = true;
      vizCanvas.style.opacity = '1';
      break;
    case 'error':
      icons.error && show(icons.error);
      label.textContent = 'Erreur — réessaie';
      btnMic.disabled = false;
      btnMic.classList.remove('listening');
      iconDef && show(iconDef);
      iconStop && hide(iconStop);
      lblMic.textContent = 'Parler';
      vizCanvas.style.opacity = '0';
      break;
  }
}

// ─── Affichage conversation ───────────────────────────────────────────────────
function addMessage(role, text) {
  const conv  = $('conversation');
  const empty = $('conv-empty');
  if (empty) hide(empty);

  const wrap = document.createElement('div');
  wrap.className = `message ${role === 'user' ? 'user' : 'ai'}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = role === 'user'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.43a2 2 0 0 1 1.99-2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.13 6.13l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  conv.appendChild(wrap);
  conv.scrollTop = conv.scrollHeight;
}

// ─── Transcript live ─────────────────────────────────────────────────────────
function showTranscript(text, isFinal) {
  const el = $('transcript-live');
  el.textContent = text;
  el.classList.add('visible');
  el.classList.toggle('interim', !isFinal);
  el.classList.toggle('final', isFinal);
}

function clearTranscript() {
  const el = $('transcript-live');
  el.textContent = '';
  el.classList.remove('visible', 'interim', 'final');
}

// ─── Visualiseur audio ────────────────────────────────────────────────────────
function startViz(stream) {
  if (!STATE.audioCtx) STATE.audioCtx = new AudioContext();
  STATE.analyser = STATE.audioCtx.createAnalyser();
  STATE.analyser.fftSize = 64;
  const src = STATE.audioCtx.createMediaStreamSource(stream);
  src.connect(STATE.analyser);

  const canvas = $('audio-viz');
  const ctx    = canvas.getContext('2d');
  const buf    = new Uint8Array(STATE.analyser.frequencyBinCount);

  function draw() {
    STATE.vizRaf = requestAnimationFrame(draw);
    STATE.analyser.getByteFrequencyData(buf);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barW = (canvas.width / buf.length) * 2;
    buf.forEach((v, i) => {
      const h  = (v / 255) * canvas.height;
      const hue = 240 + i * 2;
      ctx.fillStyle = `hsla(${hue}, 70%, 60%, 0.8)`;
      ctx.fillRect(i * (barW + 1), canvas.height - h, barW, h);
    });
  }
  draw();
}

function stopViz() {
  if (STATE.vizRaf) { cancelAnimationFrame(STATE.vizRaf); STATE.vizRaf = null; }
  const canvas = $('audio-viz');
  const ctx    = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ─── Deepgram STT ─────────────────────────────────────────────────────────────
async function startListening() {
  setOrbState('listening');
  clearTranscript();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setOrbState('error');
    $('status-label').textContent = 'Micro non accessible';
    return;
  }

  startViz(stream);

  // Récupérer le token Deepgram
  const tokenRes = await fetch('/api/deepgram-token');
  const { token } = await tokenRes.json();

  STATE.deepgramSocket = new WebSocket(
    `wss://api.deepgram.com/v1/listen?language=fr&model=nova-3&punctuate=true&interim_results=true&endpointing=500`,
    ['token', token]
  );

  STATE.deepgramSocket.onopen = () => {
    STATE.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    STATE.mediaRecorder.ondataavailable = e => {
      if (STATE.deepgramSocket.readyState === WebSocket.OPEN) {
        STATE.deepgramSocket.send(e.data);
      }
    };
    STATE.mediaRecorder.start(250);
  };

  let finalTranscript = '';

  STATE.deepgramSocket.onmessage = async e => {
    const msg = JSON.parse(e.data);
    const alt = msg.channel?.alternatives?.[0];
    if (!alt) return;

    const text    = alt.transcript.trim();
    const isFinal = msg.speech_final;

    if (!text) return;

    if (isFinal) {
      finalTranscript += (finalTranscript ? ' ' : '') + text;
      showTranscript(finalTranscript, true);
    } else {
      showTranscript(finalTranscript + (finalTranscript ? ' ' : '') + text, false);
    }
  };

  STATE.deepgramSocket.onerror = () => setOrbState('error');
}

function stopListening() {
  if (STATE.mediaRecorder && STATE.mediaRecorder.state !== 'inactive') {
    STATE.mediaRecorder.stop();
    STATE.mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  if (STATE.deepgramSocket) {
    STATE.deepgramSocket.close();
    STATE.deepgramSocket = null;
  }
  stopViz();
}

// ─── Pipeline LLM → TTS ──────────────────────────────────────────────────────
async function processUtterance(text) {
  if (!text.trim()) { setOrbState('idle'); return; }

  clearTranscript();
  addMessage('user', text);
  STATE.conversationHistory.push({ role: 'user', content: text });
  STATE.fullTranscription.push({
    locuteur: 'commercial', texte: text,
    horodatageSecondes: STATE.sessionStartTime ? Math.floor((Date.now() - STATE.sessionStartTime) / 1000) : 0
  });

  setOrbState('thinking');

  try {
    const chatRes = await fetch('/api/chat', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        messages: STATE.conversationHistory,
        persona : STATE.currentPersona,
        config  : STATE.currentConfig
      })
    });

    if (!chatRes.ok) throw new Error(`LLM error ${chatRes.status}`);
    const { text: aiText } = await chatRes.json();

    if (!aiText) throw new Error('Réponse vide du LLM');

    addMessage('ai', aiText);
    STATE.conversationHistory.push({ role: 'assistant', content: aiText });
    STATE.fullTranscription.push({
      locuteur: 'prospect', texte: aiText,
      horodatageSecondes: STATE.sessionStartTime ? Math.floor((Date.now() - STATE.sessionStartTime) / 1000) : 0
    });

    await playTTS(aiText);
  } catch (err) {
    console.error('[processUtterance]', err);
    setOrbState('error');
    $('status-label').textContent = 'Erreur — réessaie';
  }
}

async function playTTS(text) {
  setOrbState('speaking');

  try {
    const ttsRes = await fetch('/api/tts', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ text })
    });

    if (!ttsRes.ok) throw new Error(`TTS error ${ttsRes.status}`);

    const buffer = await ttsRes.arrayBuffer();

    if (!STATE.audioCtx) STATE.audioCtx = new AudioContext();
    const decoded = await STATE.audioCtx.decodeAudioData(buffer);

    // Analyser pour visualisation TTS
    const analyser = STATE.audioCtx.createAnalyser();
    analyser.fftSize = 64;
    const canvas = $('audio-viz');
    const ctx    = canvas.getContext('2d');
    const buf    = new Uint8Array(analyser.frequencyBinCount);
    canvas.style.opacity = '1';

    function drawTTS() {
      STATE.vizRaf = requestAnimationFrame(drawTTS);
      analyser.getByteFrequencyData(buf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barW = (canvas.width / buf.length) * 2;
      buf.forEach((v, i) => {
        const h = (v / 255) * canvas.height;
        ctx.fillStyle = `hsla(150, 65%, 55%, 0.8)`;
        ctx.fillRect(i * (barW + 1), canvas.height - h, barW, h);
      });
    }
    drawTTS();

    STATE.ttsSource = STATE.audioCtx.createBufferSource();
    STATE.ttsSource.buffer = decoded;
    STATE.ttsSource.connect(analyser);
    analyser.connect(STATE.audioCtx.destination);
    STATE.ttsSource.start();

    STATE.ttsSource.onended = () => {
      stopViz();
      canvas.style.opacity = '0';
      setOrbState('idle');
    };
  } catch (err) {
    console.error('[playTTS]', err);
    setOrbState('error');
  }
}

// ─── Bouton micro ─────────────────────────────────────────────────────────────
function initMicButton() {
  const btnMic = $('btn-mic');
  let isListening = false;
  let pendingFinal = '';

  btnMic.addEventListener('click', async () => {
    if ($('orb-container').dataset.state === 'speaking') {
      // Couper le TTS si l'utilisateur coupe
      if (STATE.ttsSource) {
        try { STATE.ttsSource.stop(); } catch {}
        STATE.ttsSource = null;
      }
      stopViz();
    }

    if (!isListening) {
      isListening = true;
      pendingFinal = '';

      // Patch Deepgram pour capturer les finals
      const origStart = startListening.toString();

      // On redéfinit le handler onmessage après startListening
      await startListening();

      // Patch onmessage pour accumuler les finals dans pendingFinal
      if (STATE.deepgramSocket) {
        STATE.deepgramSocket.onmessage = async e => {
          const msg = JSON.parse(e.data);
          const alt = msg.channel?.alternatives?.[0];
          if (!alt) return;
          const text    = alt.transcript.trim();
          const isFinal = msg.speech_final;
          if (!text) return;
          if (isFinal) {
            pendingFinal += (pendingFinal ? ' ' : '') + text;
            showTranscript(pendingFinal, true);
          } else {
            showTranscript(pendingFinal + (pendingFinal ? ' ' : '') + text, false);
          }
        };
      }
    } else {
      isListening = false;
      stopListening();
      if (pendingFinal.trim()) {
        await processUtterance(pendingFinal.trim());
      } else {
        setOrbState('idle');
      }
      pendingFinal = '';
    }
  });
}

// ─── Bouton Terminer ──────────────────────────────────────────────────────────
function initEndButton() {
  $('btn-end').addEventListener('click', endSession);
}

async function endSession() {
  const duree = stopTimer();
  stopListening();
  if (STATE.ttsSource) { try { STATE.ttsSource.stop(); } catch {} }
  setOrbState('idle');

  // Sauvegarder en base
  if (STATE.simulationId) {
    fetch('/api/simulation/end', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        simulationId: STATE.simulationId,
        dureeSecondes: duree,
        transcription: STATE.fullTranscription
      })
    }).catch(() => {});
  }

  // Générer le bilan
  if (STATE.fullTranscription.length < 2) {
    // Pas assez de contenu pour un bilan
    alert('La simulation est trop courte pour générer un bilan.');
    showBilanEmpty();
    return;
  }

  showBilanLoading();

  try {
    const res = await fetch('/api/bilan', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        simulationId: STATE.simulationId,
        transcription: STATE.fullTranscription,
        config      : STATE.currentConfig,
        personaData : STATE.currentPersona
      })
    });
    const bilan = await res.json();
    if (!res.ok) throw new Error(bilan.error);
    showBilan(bilan, duree);
  } catch (err) {
    console.error('[Bilan]', err);
    showBilanError();
  }
}

function showBilanLoading() {
  $('bilan-note').textContent    = '…';
  $('bilan-positifs').textContent = 'Analyse en cours…';
  $('bilan-negatifs').textContent = '';
  $('bilan-conseils').textContent = '';
  $('bilan-subtitle').textContent = '';
  show($('bilan-modal'));
}

function showBilanEmpty() {
  showBilan({ note_globale: '—', points_positifs: 'Simulation trop courte.', points_negatifs: '', conseils: 'Lance un appel plus long pour obtenir une analyse.' }, 0);
}

function showBilanError() {
  showBilan({ note_globale: '—', points_positifs: '', points_negatifs: '', conseils: 'Impossible de générer le bilan (erreur serveur).' }, 0);
}

function showBilan(bilan, duree) {
  const p = STATE.currentPersona;
  const c = STATE.currentConfig;
  const dureeStr = duree ? `${Math.floor(duree / 60)}m${String(duree % 60).padStart(2, '0')}s` : '';
  $('bilan-subtitle').textContent = [
    p ? `${p.prenom} · ${p.poste_exact}` : '',
    c ? ({ cold_call: 'Cold Call', rdv: 'RDV' }[c.mode] || '') : '',
    dureeStr
  ].filter(Boolean).join(' · ');

  $('bilan-note').textContent     = `${bilan.note_globale}/10`;
  $('bilan-positifs').textContent = bilan.points_positifs || '—';
  $('bilan-negatifs').textContent = bilan.points_negatifs || '—';
  $('bilan-conseils').textContent = bilan.conseils || '—';

  show($('bilan-modal'));
}

function initBilanButtons() {
  $('btn-bilan-close').addEventListener('click', () => hide($('bilan-modal')));

  $('btn-new-simulation').addEventListener('click', () => {
    hide($('bilan-modal'));
    STATE.currentPersona = null;
    STATE.currentConfig  = { type: 'b2b', mode: 'cold_call', subMode: 'complet', canal: 'fixe', difficulty: 'facile', secteur: '', poste: '', taille: 'pme', produit: '' };
    showScreen('config-screen');
    showStep(1);
    resetOptionTiles();
    resetInputs();
  });

  $('btn-replay-config').addEventListener('click', async () => {
    hide($('bilan-modal'));
    // Regénérer un persona avec la même config
    await generatePersona();
  });
}

function resetOptionTiles() {
  document.querySelectorAll('.option-tile[data-group]').forEach(tile => {
    tile.classList.remove('active');
    const check = tile.querySelector('.tile-check');
    if (check) hide(check);
  });
  // Remettre les défauts
  const defaults = { type: 'b2b', mode: 'cold_call', subMode: 'complet', canal: 'fixe', difficulty: 'facile' };
  Object.entries(defaults).forEach(([group, value]) => {
    const tile = document.querySelector(`.option-tile[data-group="${group}"][data-value="${value}"]`);
    if (tile) {
      tile.classList.add('active');
      const check = tile.querySelector('.tile-check');
      if (check) show(check);
    }
  });
}

function resetInputs() {
  ['input-secteur', 'input-poste', 'input-profil-b2c', 'input-produit'].forEach(id => {
    const el = $(id);
    if (el) el.value = '';
  });
  const sel = $('select-taille');
  if (sel) sel.value = 'pme';
}

// ════════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initConfig();
  initBriefing();
  initMicButton();
  initEndButton();
  initBilanButtons();
  showScreen('login-screen');
});
