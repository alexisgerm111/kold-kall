// ════════════════════════════════════════════════════════════════════════════
//  KOLD KALL V0 — Logique Frontend
//  Pipeline : Deepgram WebSocket (STT) → Gemini Flash Lite (LLM) → Cartesia (TTS)
//  Auth + BDD : Supabase via serveur Node.js
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── PERSONAS ────────────────────────────────────────────────────────────────
const PERSONAS = [
  {
    id         : 'prospect_direct',
    name       : 'Prospect Direct',
    description: 'Décideur à appeler directement',
    color      : '#2563EB',
    iconSvg    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    systemPrompt: `Tu joues le rôle d'un prospect (décideur en entreprise) qui reçoit un appel téléphonique commercial à froid. Tu parles en français de façon naturelle. Tu peux être poli mais occupé, légèrement méfiant, parfois intéressé si le commercial est convaincant. Tu poses des objections réalistes (pas le temps, déjà un prestataire, prix...). Règle absolue : tes réponses font TOUJOURS 1 à 3 phrases maximum. Reste réaliste, pas caricatural. Pas de listes ni de markdown.`
  },
  {
    id         : 'barrage_secretaire',
    name       : 'Secrétaire Barrage',
    description: 'Brigitte — filtre les appels',
    color      : '#DC2626',
    iconSvg    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`,
    systemPrompt: `Tu joues le rôle de Brigitte, secrétaire de direction qui filtre les appels commerciaux pour protéger son patron. Tu parles en français de façon professionnelle mais ferme. Tu demandes systématiquement l'objet de l'appel, tu interroges sur la relation avec le patron, tu peux dire qu'il est en réunion. Si le commercial est vraiment habile et convaincant, tu peux éventuellement passer l'appel. Règle absolue : tes réponses font TOUJOURS 1 à 3 phrases maximum. Pas de listes ni de markdown.`
  },
  {
    id         : 'client_difficile',
    name       : 'Client Difficile',
    description: 'Sceptique et exigeant',
    color      : '#D97706',
    iconSvg    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    systemPrompt: `Tu joues le rôle d'un prospect sceptique et exigeant pour entraîner des commerciaux. Tu parles en français de façon directe et parfois abrupte. Tu poses des objections sur le prix, tu compares avec la concurrence, tu demandes des preuves concrètes. Règle absolue : tes réponses font TOUJOURS 1 à 3 phrases maximum. Tu restes réaliste, pas caricatural. Pas de listes ni de markdown.`
  }
];

// ─── ÉTAT GLOBAL ──────────────────────────────────────────────────────────────
const State = Object.freeze({
  IDLE     : 'idle',
  LISTENING: 'listening',
  THINKING : 'thinking',
  SPEAKING : 'speaking',
  ERROR    : 'error'
});

let currentState        = State.IDLE;
let currentPersonaId    = 'prospect_direct';
let conversationHistory = [];
let isProcessing        = false;

// Session utilisateur
let currentUser         = null;
let currentProfile      = null;
let currentSimulationId = null;
let simulationStartTime = null;
let fullTranscription   = []; // Toutes les lignes de la conversation

// Ressources audio/réseau
let deepgramSocket  = null;
let mediaRecorder   = null;
let audioStream     = null;
let keepAliveTimer  = null;
let audioCtx        = null;
let analyserNode    = null;
let vizFrame        = null;

// ─── RÉFÉRENCES DOM ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Login
const loginScreen    = $('login-screen');
const loginForm      = $('login-form');
const loginEmail     = $('login-email');
const loginPassword  = $('login-password');
const loginBtn       = $('login-btn');
const loginError     = $('login-error');

// App principale
const appScreen      = $('app-screen');
const userNameEl     = $('user-name');

// Simulation
const orbContainer   = $('orb-container');
const statusLabel    = $('status-label');
const transcriptLive = $('transcript-live');
const conversation   = $('conversation');
const convEmpty      = $('conv-empty');
const btnMic         = $('btn-mic');
const btnMicLabel    = $('btn-mic-label');
const btnEnd         = $('btn-end');
const btnPersona     = $('btn-persona');
const personaBadge   = $('persona-badge');
const modalOverlay   = $('modal-overlay');
const btnSheetClose  = $('btn-sheet-close');
const personaGrid    = $('persona-grid');
const audioViz       = $('audio-viz');

// Modale bilan
const bilanModal     = $('bilan-modal');
const bilanNote      = $('bilan-note');
const bilanPositifs  = $('bilan-positifs');
const bilanNegatifs  = $('bilan-negatifs');
const bilanConseils  = $('bilan-conseils');
const btnBilanClose  = $('btn-bilan-close');
const btnNewSim      = $('btn-new-simulation');

// Icônes orb
const iconMic    = $('icon-mic');
const iconWave   = $('icon-wave');
const iconLoader = $('icon-loader');
const iconSound  = $('icon-sound');
const iconError  = $('icon-error');

// Icônes bouton mic
const micIconDefault = $('mic-icon-default');
const micIconStop    = $('mic-icon-stop');

// ════════════════════════════════════════════════════════════════════════════
//  AUTHENTIFICATION
// ════════════════════════════════════════════════════════════════════════════

async function handleLogin(e) {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Connexion...';

  try {
    const res = await fetch('/api/auth/login', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        email   : loginEmail.value.trim(),
        password: loginPassword.value
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur de connexion');

    currentUser    = data.user;
    currentProfile = data.profile;

    showApp();
  } catch (err) {
    loginError.textContent = err.message;
    loginBtn.disabled = false;
    loginBtn.textContent = 'Se connecter';
  }
}

function showApp() {
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');

  const prenom = currentProfile?.prenom || currentUser?.email?.split('@')[0] || 'Utilisateur';
  userNameEl.textContent = prenom;

  renderPersonaGrid();
  setState(State.IDLE);
}

// ════════════════════════════════════════════════════════════════════════════
//  GESTION DE LA SIMULATION
// ════════════════════════════════════════════════════════════════════════════

async function startSimulation() {
  if (!currentUser) return;

  const persona = getPersona(currentPersonaId);

  try {
    const res = await fetch('/api/simulation/start', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        userId          : currentUser.id,
        typeScenario    : currentPersonaId,
        niveauDifficulte: 'moyen',
        modeJeu         : 'entrainement'
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentSimulationId = data.simulationId;
    simulationStartTime = Date.now();
    fullTranscription   = [];

    console.log(`[Simulation] ▶ Démarrée : ${currentSimulationId}`);
    btnEnd.classList.remove('hidden');
  } catch (err) {
    console.error('[Simulation] Erreur démarrage :', err.message);
  }
}

async function endSimulation() {
  if (!currentSimulationId) return;

  const dureeSecondes = Math.floor((Date.now() - simulationStartTime) / 1000);

  try {
    // 1. Clôturer la simulation
    await fetch('/api/simulation/end', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        simulationId  : currentSimulationId,
        dureeSecondes,
        transcription : fullTranscription
      })
    });

    // 2. Générer le bilan
    statusLabel.textContent = 'Génération du bilan...';
    btnEnd.classList.add('hidden');
    btnMic.disabled = true;

    const bilanRes = await fetch('/api/bilan', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        simulationId : currentSimulationId,
        transcription: fullTranscription
      })
    });

    const bilan = await bilanRes.json();
    if (!bilanRes.ok) throw new Error(bilan.error);

    // 3. Afficher le bilan
    showBilan(bilan);

  } catch (err) {
    console.error('[Simulation] Erreur fin :', err.message);
    setState(State.IDLE);
    btnMic.disabled = false;
  }

  currentSimulationId = null;
}

function showBilan(bilan) {
  bilanNote.textContent     = `${bilan.note_globale}/10`;
  bilanPositifs.textContent = bilan.points_positifs;
  bilanNegatifs.textContent = bilan.points_negatifs;
  bilanConseils.textContent = bilan.conseils;

  // Couleur de la note
  const note = bilan.note_globale;
  bilanNote.style.color = note >= 7 ? '#22C55E' : note >= 5 ? '#F59E0B' : '#EF4444';

  bilanModal.classList.remove('hidden');
  setState(State.IDLE);
  btnMic.disabled = false;
}

function closeBilan() {
  bilanModal.classList.add('hidden');
}

function resetSimulation() {
  closeBilan();
  conversationHistory = [];
  fullTranscription   = [];
  conversation.innerHTML = '';
  if (convEmpty) conversation.appendChild(convEmpty);
  if (convEmpty) convEmpty.style.display = '';
  setState(State.IDLE);
}

// ════════════════════════════════════════════════════════════════════════════
//  MACHINE D'ÉTAT
// ════════════════════════════════════════════════════════════════════════════

function setState(newState) {
  currentState = newState;
  orbContainer.dataset.state = newState;

  const STATUS = {
    [State.IDLE]     : 'Prêt à écouter',
    [State.LISTENING]: 'En écoute...',
    [State.THINKING] : 'Je réfléchis...',
    [State.SPEAKING] : 'Je vous réponds...',
    [State.ERROR]    : 'Une erreur est survenue'
  };
  const BTN_LABELS = {
    [State.IDLE]     : 'Parler',
    [State.LISTENING]: 'Arrêter',
    [State.THINKING] : 'Patientez...',
    [State.SPEAKING] : 'Patientez...',
    [State.ERROR]    : 'Réessayer'
  };

  statusLabel.textContent = STATUS[newState] || '';
  btnMicLabel.textContent = BTN_LABELS[newState] || '';

  [iconMic, iconWave, iconLoader, iconSound, iconError].forEach(el => el.classList.add('hidden'));
  const orbIcons = {
    [State.IDLE]     : iconMic,
    [State.LISTENING]: iconWave,
    [State.THINKING] : iconLoader,
    [State.SPEAKING] : iconSound,
    [State.ERROR]    : iconError
  };
  orbIcons[newState]?.classList.remove('hidden');

  btnMic.disabled = (newState === State.THINKING || newState === State.SPEAKING);

  if (newState === State.LISTENING) {
    btnMic.classList.add('listening');
    micIconDefault.classList.add('hidden');
    micIconStop.classList.remove('hidden');
    btnMic.setAttribute('aria-label', "Arrêter l'écoute");
  } else {
    btnMic.classList.remove('listening');
    micIconDefault.classList.remove('hidden');
    micIconStop.classList.add('hidden');
    btnMic.setAttribute('aria-label', 'Commencer à parler');
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════════

function init() {
  // Login
  loginForm.addEventListener('submit', handleLogin);

  // Boutons simulation
  btnMic.addEventListener('click', handleMicClick);
  btnEnd.addEventListener('click', endSimulation);
  btnBilanClose.addEventListener('click', closeBilan);
  btnNewSim.addEventListener('click', resetSimulation);

  // Persona
  btnPersona.addEventListener('click', openModal);
  btnSheetClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  if (typeof gsap !== 'undefined') {
    gsap.from('.login-card', { y: 20, opacity: 0, duration: 0.5, ease: 'power2.out' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  PIPELINE VOCAL
// ════════════════════════════════════════════════════════════════════════════

async function handleMicClick() {
  // Démarrer la simulation au premier clic
  if (!currentSimulationId && (currentState === State.IDLE || currentState === State.ERROR)) {
    await startSimulation();
  }

  if (currentState === State.IDLE || currentState === State.ERROR) {
    await startListening();
  } else if (currentState === State.LISTENING) {
    await stopListening();
  }
}

async function startListening() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert("Votre navigateur ne supporte pas l'accès au microphone.");
      return;
    }

    const tokenRes = await fetch('/api/deepgram-token');
    if (!tokenRes.ok) throw new Error('Impossible de récupérer le token Deepgram');
    const { token } = await tokenRes.json();

    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
    });

    const params = new URLSearchParams({
      model          : 'nova-3',
      language       : 'fr',
      smart_format   : 'true',
      interim_results: 'true',
      punctuate      : 'true',
      endpointing    : '1200',
      utterance_end_ms: '1500'
    });

    deepgramSocket = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params}`,
      ['token', token]
    );

    deepgramSocket.addEventListener('open', () => {
      setState(State.LISTENING);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';

      mediaRecorder = new MediaRecorder(audioStream, { mimeType });
      mediaRecorder.addEventListener('dataavailable', ({ data }) => {
        if (data.size > 0 && deepgramSocket?.readyState === WebSocket.OPEN) {
          deepgramSocket.send(data);
        }
      });
      mediaRecorder.start(250);

      keepAliveTimer = setInterval(() => {
        if (deepgramSocket?.readyState === WebSocket.OPEN) {
          deepgramSocket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 5000);
    });

    deepgramSocket.addEventListener('message', async (event) => {
      if (currentState !== State.LISTENING) return;

      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type !== 'Results') return;

      const transcript = data.channel?.alternatives?.[0]?.transcript || '';
      if (!transcript.trim()) return;

      if (!data.is_final) {
        showTranscript(transcript, 'interim');
      } else {
        showTranscript(transcript, 'final');
        if (data.speech_final && !isProcessing) {
          await processUtterance(transcript.trim());
        }
      }
    });

    deepgramSocket.addEventListener('error', () => {
      cleanupAudio();
      setState(State.ERROR);
      setTimeout(() => setState(State.IDLE), 3000);
    });

    deepgramSocket.addEventListener('close', e => {
      console.log('[DG] Connexion fermée :', e.code);
    });

  } catch (err) {
    if (err.name === 'NotAllowedError') {
      alert('Accès au microphone refusé. Autorisez-le dans votre navigateur.');
    }
    cleanupAudio();
    setState(State.ERROR);
    setTimeout(() => setState(State.IDLE), 3000);
  }
}

async function stopListening() {
  if (currentState !== State.LISTENING) return;
  const pendingText = transcriptLive.textContent.trim();
  cleanupAudio();
  if (pendingText && !isProcessing) {
    await processUtterance(pendingText);
  } else if (!isProcessing) {
    hideTranscript();
    setState(State.IDLE);
  }
}

async function processUtterance(userText) {
  if (isProcessing || !userText) return;
  isProcessing = true;

  cleanupAudio();
  addMessage('user', userText);
  hideTranscript();

  // Enregistrer dans la transcription complète
  const elapsed = simulationStartTime ? Math.floor((Date.now() - simulationStartTime) / 1000) : 0;
  fullTranscription.push({ locuteur: 'commercial', texte: userText, horodatageSecondes: elapsed });

  conversationHistory.push({ role: 'user', content: userText });
  setState(State.THINKING);

  try {
    const persona = getPersona(currentPersonaId);

    const chatRes = await fetch('/api/chat', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        messages    : conversationHistory,
        systemPrompt: persona.systemPrompt
      })
    });

    if (!chatRes.ok) throw new Error(`Chat API ${chatRes.status}`);

    const { text: aiText } = await chatRes.json();

    addMessage('ai', aiText);
    conversationHistory.push({ role: 'assistant', content: aiText });

    // Enregistrer la réponse IA dans la transcription
    const elapsedAi = simulationStartTime ? Math.floor((Date.now() - simulationStartTime) / 1000) : 0;
    fullTranscription.push({ locuteur: 'ia', texte: aiText, horodatageSecondes: elapsedAi });

    setState(State.SPEAKING);
    await playTTS(aiText);
    setState(State.IDLE);

  } catch (err) {
    console.error('[Pipeline] Erreur :', err.message);
    addMessage('ai', 'Désolé, une erreur est survenue. Veuillez réessayer.');
    setState(State.ERROR);
    setTimeout(() => setState(State.IDLE), 2500);
  } finally {
    isProcessing = false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  TTS + AUDIO
// ════════════════════════════════════════════════════════════════════════════

async function playTTS(text) {
  const ttsRes = await fetch('/api/tts', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ text })
  });

  if (!ttsRes.ok) throw new Error(`Cartesia ${ttsRes.status}`);

  const arrayBuffer = await ttsRes.arrayBuffer();

  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.75;

  const decodedData = await audioCtx.decodeAudioData(arrayBuffer);
  const source = audioCtx.createBufferSource();
  source.buffer = decodedData;
  source.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);

  startVisualizer();
  source.start(0);

  return new Promise(resolve => {
    source.onended = () => { stopVisualizer(); resolve(); };
  });
}

function startVisualizer() {
  if (!analyserNode) return;
  audioViz.style.opacity = '1';
  const ctx    = audioViz.getContext('2d');
  const bufLen = analyserNode.frequencyBinCount;
  const data   = new Uint8Array(bufLen);
  const BARS   = 28;
  const stride = Math.floor(bufLen / BARS);
  const W = audioViz.width, H = audioViz.height;
  const gap = 3, barW = (W - gap * (BARS - 1)) / BARS;

  function draw() {
    vizFrame = requestAnimationFrame(draw);
    analyserNode.getByteFrequencyData(data);
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < BARS; i++) {
      const val = data[i * stride] / 255;
      const barH = Math.max(4, val * H * 0.88);
      const x = i * (barW + gap), y = (H - barH) / 2;
      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0, `rgba(108, 99, 255, ${0.4 + val * 0.6})`);
      grad.addColorStop(1, `rgba(16, 185, 129, ${0.4 + val * 0.6})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, barH, 2);
      else ctx.rect(x, y, barW, barH);
      ctx.fill();
    }
  }
  draw();
}

function stopVisualizer() {
  cancelAnimationFrame(vizFrame);
  vizFrame = null;
  audioViz.style.opacity = '0';
  audioViz.getContext('2d').clearRect(0, 0, audioViz.width, audioViz.height);
}

function cleanupAudio() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  mediaRecorder = null;
  if (deepgramSocket) {
    try {
      if (deepgramSocket.readyState === WebSocket.OPEN) {
        deepgramSocket.send(JSON.stringify({ type: 'CloseStream' }));
      }
      deepgramSocket.close();
    } catch (_) {}
    deepgramSocket = null;
  }
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  UI HELPERS
// ════════════════════════════════════════════════════════════════════════════

function showTranscript(text, mode) {
  transcriptLive.textContent = text;
  transcriptLive.className   = `transcript-live visible ${mode}`;
}

function hideTranscript() {
  transcriptLive.textContent = '';
  transcriptLive.className   = 'transcript-live';
}

function addMessage(role, text) {
  if (convEmpty) convEmpty.style.display = 'none';
  const isUser = role === 'user';

  const userAvatarSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const aiAvatarSvg   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/></svg>`;

  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.innerHTML = `
    <div class="msg-avatar" aria-hidden="true">${isUser ? userAvatarSvg : aiAvatarSvg}</div>
    <div class="msg-bubble">${escapeHtml(text)}</div>
  `;
  conversation.appendChild(el);
  requestAnimationFrame(() => {
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' });
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;')
    .replace(/\n/g, '<br>');
}

// ════════════════════════════════════════════════════════════════════════════
//  PERSONAS
// ════════════════════════════════════════════════════════════════════════════

function getPersona(id) {
  return PERSONAS.find(p => p.id === id) ?? PERSONAS[0];
}

function renderPersonaGrid() {
  personaGrid.innerHTML = PERSONAS.map(p => `
    <button
      class="persona-card ${p.id === currentPersonaId ? 'active' : ''}"
      data-pid="${p.id}"
      style="--card-clr: ${p.color}"
      aria-pressed="${p.id === currentPersonaId}"
    >
      <div class="card-icon">${p.iconSvg}</div>
      <div class="card-name">${p.name}</div>
      <div class="card-desc">${p.description}</div>
    </button>
  `).join('');

  personaGrid.querySelectorAll('.persona-card').forEach(card => {
    card.addEventListener('click', () => { selectPersona(card.dataset.pid); closeModal(); });
  });
}

function selectPersona(id) {
  if (currentSimulationId) return; // Pas de changement en cours de simulation
  currentPersonaId    = id;
  conversationHistory = [];
  fullTranscription   = [];
  conversation.innerHTML = '';
  if (convEmpty) { conversation.appendChild(convEmpty); convEmpty.style.display = ''; }

  const p = getPersona(id);
  personaBadge.textContent = p.name;
  document.documentElement.style.setProperty('--accent', p.color);
  document.documentElement.style.setProperty('--clr-idle', p.color);

  renderPersonaGrid();
}

function openModal() {
  if (currentState !== State.IDLE && currentState !== State.ERROR) return;
  renderPersonaGrid();
  modalOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
