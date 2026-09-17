// ════════════════════════════════════════════════════════════════════════════
//  KOLD KALL V1 — Logique Frontend
//  Auth : login, signup, mot de passe oublié
//  Pipeline : Deepgram → Gemini 3.5 Flash Lite → Cartesia
//  Configuration et contexte : serveur / Supabase
// ════════════════════════════════════════════════════════════════════════════

'use strict';

// ─── ÉTAT GLOBAL ─────────────────────────────────────────────────────────────
const State = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  ERROR: 'error'
});

let currentState = State.IDLE;
let isProcessing = false;

// Session
let currentUser = null;
let currentProfile = null;
let authAccessToken = null;
let currentSimulationId = null;
let currentSimulationConfig = null;
let simulationReady = false;
let simulationStartTime = null;
let fullTranscription = [];

// Audio/réseau
let deepgramSocket = null;
let mediaRecorder = null;
let audioStream = null;
let keepAliveTimer = null;
let audioCtx = null;
let analyserNode = null;
let vizFrame = null;

// Enregistrement complet de la simulation
let simulationRecorder = null;
let recordedAudioChunks = [];
let recordingDestination = null;
let microphoneSource = null;

// Agrégation des segments Deepgram
let finalUtteranceParts = [];
let interimUtterance = '';

// ─── DOM ──────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const loginScreen = $('login-screen');
const appScreen = $('app-screen');

const loginForm = $('login-form');
const loginEmail = $('login-email');
const loginPassword = $('login-password');
const loginBtn = $('login-btn');
const loginError = $('login-error');
const toggleEyeLogin = $('toggle-eye-login');
const btnShowSignup = $('btn-show-signup');
const btnForgot = $('btn-forgot');

const signupPanel = $('signup-panel');
const signupNom = $('signup-nom');
const signupPrenom = $('signup-prenom');
const signupEmail = $('signup-email');
const signupPassword = $('signup-password');
const signupBtn = $('signup-btn');
const signupError = $('signup-error');
const signupSuccess = $('signup-success');
const toggleEyeSignup = $('toggle-eye-signup');
const btnShowLogin = $('btn-show-login');

const userNameEl = $('user-name');
const orbContainer = $('orb-container');
const statusLabel = $('status-label');
const transcriptLive = $('transcript-live');
const conversation = $('conversation');
const convEmpty = $('conv-empty');
const btnMic = $('btn-mic');
const btnMicLabel = $('btn-mic-label');
const btnEnd = $('btn-end');
const audioViz = $('audio-viz');

const iconMic = $('icon-mic');
const iconWave = $('icon-wave');
const iconLoader = $('icon-loader');
const iconSound = $('icon-sound');
const iconError = $('icon-error');

const micIconDefault = $('mic-icon-default');
const micIconStop = $('mic-icon-stop');

// ════════════════════════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════════════════════════

function init() {
  loginForm.addEventListener('submit', handleLogin);
  toggleEyeLogin.addEventListener('click', () => togglePasswordVisibility(loginPassword, toggleEyeLogin));
  btnShowSignup.addEventListener('click', showSignupPanel);
  btnForgot.addEventListener('click', handleForgotPassword);

  signupBtn.addEventListener('click', handleSignup);
  toggleEyeSignup.addEventListener('click', () => togglePasswordVisibility(signupPassword, toggleEyeSignup));
  btnShowLogin.addEventListener('click', showLoginPanel);

  btnMic.addEventListener('click', handleMicClick);
  btnEnd.addEventListener('click', endSimulation);
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════════════════

function togglePasswordVisibility(input, btn) {
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.innerHTML = isHidden
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" x2="23" y1="1" y2="23"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function showSignupPanel() {
  signupPanel.classList.remove('hidden');
  loginForm.classList.add('hidden');
  loginError.textContent = '';
}

function showLoginPanel() {
  signupPanel.classList.add('hidden');
  loginForm.classList.remove('hidden');
  signupError.textContent = '';
  signupSuccess.textContent = '';
}

async function handleLogin(e) {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;
  loginBtn.textContent = 'Connexion...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: loginEmail.value.trim(),
        password: loginPassword.value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur de connexion');

    currentUser = data.user;
    currentProfile = data.profile;
    authAccessToken = data.session?.access_token || null;
    showApp();
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Se connecter';
  }
}

async function handleSignup() {
  signupError.textContent = '';
  signupSuccess.textContent = '';
  signupBtn.disabled = true;
  signupBtn.textContent = 'Création...';

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: signupEmail.value.trim(),
        password: signupPassword.value,
        nom: signupNom.value.trim(),
        prenom: signupPrenom.value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur de création');
    signupSuccess.textContent = '✅ Compte créé ! Vérifiez votre email puis connectez-vous.';
    setTimeout(showLoginPanel, 3000);
  } catch (err) {
    signupError.textContent = err.message;
  } finally {
    signupBtn.disabled = false;
    signupBtn.textContent = 'Créer mon compte';
  }
}

async function handleForgotPassword() {
  const email = loginEmail.value.trim();
  if (!email) {
    loginError.textContent = 'Entrez votre email ci-dessus puis cliquez sur ce lien.';
    return;
  }

  loginError.textContent = '';
  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    loginError.style.color = 'var(--success)';
    loginError.textContent = '✅ Email de réinitialisation envoyé.';
    setTimeout(() => {
      loginError.style.color = '';
      loginError.textContent = '';
    }, 4000);
  } catch (err) {
    loginError.textContent = err.message;
  }
}

function showApp() {
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  const prenom = currentProfile?.prenom || currentUser?.email?.split('@')[0] || 'Utilisateur';
  userNameEl.textContent = prenom;

  if (simulationReady) {
    btnMic.disabled = false;
  } else {
    btnMic.disabled = true;
    statusLabel.textContent = 'Lance une simulation depuis le dashboard.';
  }
  setState(State.IDLE);
}

// ════════════════════════════════════════════════════════════════════════════
//  CONTEXTE SIMULATION
// ════════════════════════════════════════════════════════════════════════════

async function loadSimulationContext(simulationId) {
  simulationReady = false;
  btnMic.disabled = true;
  statusLabel.textContent = 'Préparation du scénario...';

  for (let attempt = 0; attempt < 90; attempt++) {
    const res = await fetch(
      `/api/simulation/context?simulationId=${encodeURIComponent(simulationId)}`,
      { headers: authAccessToken ? { Authorization: `Bearer ${authAccessToken}` } : {} }
    );
    const data = await res.json();

    if (res.status === 202) {
      statusLabel.textContent = 'Préparation du scénario...';
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    if (!res.ok) throw new Error(data.error || 'Impossible de charger la simulation');

    currentSimulationId = data.simulation.id;
    currentSimulationConfig = data.simulation;
    simulationReady = true;
    simulationStartTime = null;
    fullTranscription = [];
    finalUtteranceParts = [];
    interimUtterance = '';

    conversation.innerHTML = '';
    if (convEmpty) {
      conversation.appendChild(convEmpty);
      convEmpty.style.display = '';
    }

    btnMic.disabled = false;
    const phaseLabel = data.simulation.type_entretien === 'cold_call'
      ? 'Cold Call'
      : ({ complet:'Entretien complet', decouverte:'Découverte', demo:'Démo', objections_closing:'Objections & Closing', nego:'Négociation' }[data.simulation.phase_choisie] || 'Rendez-vous');
    statusLabel.textContent = `${phaseLabel} — prêt à commencer`;
    return;
  }

  throw new Error('La préparation du scénario prend trop de temps. Réessaie depuis le dashboard.');
}

// ════════════════════════════════════════════════════════════════════════════
//  ENREGISTREMENT SIMULATION
// ════════════════════════════════════════════════════════════════════════════

async function startSimulation() {
  if (!currentUser || !currentSimulationId || !simulationReady) return;

  simulationStartTime = Date.now();
  btnEnd.classList.remove('hidden');
  recordedAudioChunks = [];

  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  recordingDestination = audioCtx.createMediaStreamDestination();

  const recordingMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  simulationRecorder = new MediaRecorder(recordingDestination.stream, { mimeType: recordingMimeType });
  simulationRecorder.addEventListener('dataavailable', ({ data }) => {
    if (data.size > 0) recordedAudioChunks.push(data);
  });
  simulationRecorder.start(250);
}

async function stopSimulationRecorder() {
  if (!simulationRecorder || simulationRecorder.state === 'inactive') return null;

  return new Promise(resolve => {
    const recorder = simulationRecorder;
    recorder.addEventListener('stop', () => {
      const blob = new Blob(recordedAudioChunks, { type: recorder.mimeType || 'audio/webm' });
      recordedAudioChunks = [];
      simulationRecorder = null;
      resolve(blob);
    }, { once: true });

    try {
      recorder.stop();
    } catch (_) {
      resolve(null);
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function endSimulation() {
  if (!currentSimulationId) return;

  const simId = currentSimulationId;
  const dureeSecondes = simulationStartTime
    ? Math.floor((Date.now() - simulationStartTime) / 1000)
    : 0;

  btnEnd.classList.add('hidden');
  btnMic.disabled = true;
  setState(State.THINKING);
  statusLabel.textContent = 'Enregistrement de la simulation...';

  cleanupAudio();

  try {
    const audioBlob = await stopSimulationRecorder();
    const audioBase64 = audioBlob ? await blobToBase64(audioBlob) : null;

    const endRes = await fetch('/api/simulation/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authAccessToken ? { Authorization: `Bearer ${authAccessToken}` } : {})
      },
      body: JSON.stringify({
        simulationId: simId,
        dureeSecondes,
        transcription: fullTranscription,
        audioBase64
      })
    });

    const endData = await endRes.json();
    if (!endRes.ok) throw new Error(endData.error || 'Erreur clôture simulation');

    window.location.href = `https://alexisgerm111.github.io/daqhboard-kold-kall/?simulationId=${encodeURIComponent(simId)}`;
  } catch (err) {
    console.error('[Simulation] Erreur fin :', err.message);
    setState(State.ERROR);
    btnMic.disabled = false;
    statusLabel.textContent = `Erreur : ${err.message}`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  MACHINE D'ÉTAT
// ════════════════════════════════════════════════════════════════════════════

function setState(newState) {
  currentState = newState;
  orbContainer.dataset.state = newState;

  const STATUS = {
    [State.IDLE]: 'Prêt à écouter',
    [State.LISTENING]: 'En écoute...',
    [State.THINKING]: 'Je réfléchis...',
    [State.SPEAKING]: 'Je vous réponds...',
    [State.ERROR]: 'Une erreur est survenue'
  };

  const BTN_LABELS = {
    [State.IDLE]: 'Parler',
    [State.LISTENING]: 'Arrêter',
    [State.THINKING]: 'Patientez...',
    [State.SPEAKING]: 'Patientez...',
    [State.ERROR]: 'Réessayer'
  };

  statusLabel.textContent = STATUS[newState] || '';
  btnMicLabel.textContent = BTN_LABELS[newState] || '';

  [iconMic, iconWave, iconLoader, iconSound, iconError].forEach(el => el.classList.add('hidden'));
  ({ [State.IDLE]: iconMic, [State.LISTENING]: iconWave, [State.THINKING]: iconLoader, [State.SPEAKING]: iconSound, [State.ERROR]: iconError })[newState]?.classList.remove('hidden');

  btnMic.disabled = !simulationReady || newState === State.THINKING || newState === State.SPEAKING;

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
//  PIPELINE VOCAL
// ════════════════════════════════════════════════════════════════════════════

async function handleMicClick() {
  if (!simulationReady || !currentSimulationId) return;

  if (currentState === State.IDLE || currentState === State.ERROR) {
    if (!simulationStartTime) await startSimulation();
    await startListening();
  } else if (currentState === State.LISTENING) {
    await stopListening();
  }
}

async function startListening() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Navigateur non supporté.');
      return;
    }

    const tokenRes = await fetch('/api/deepgram-token');
    if (!tokenRes.ok) throw new Error('Token Deepgram indisponible');
    const { token } = await tokenRes.json();

    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
    });

    if (recordingDestination && audioCtx) {
      try {
        if (microphoneSource) microphoneSource.disconnect();
        microphoneSource = audioCtx.createMediaStreamSource(audioStream);
        microphoneSource.connect(recordingDestination);
      } catch (err) {
        console.error('[Audio] Connexion micro enregistreur :', err);
      }
    }

    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'fr',
      smart_format: 'true',
      interim_results: 'true',
      punctuate: 'true',
      endpointing: '1200',
      utterance_end_ms: '1500'
    });

    deepgramSocket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', token]);

    deepgramSocket.addEventListener('open', () => {
      setState(State.LISTENING);
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      mediaRecorder = new MediaRecorder(audioStream, { mimeType });
      mediaRecorder.addEventListener('dataavailable', ({ data }) => {
        if (data.size > 0 && deepgramSocket?.readyState === WebSocket.OPEN) deepgramSocket.send(data);
      });
      mediaRecorder.start(250);
      keepAliveTimer = setInterval(() => {
        if (deepgramSocket?.readyState === WebSocket.OPEN) deepgramSocket.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 5000);
    });

    deepgramSocket.addEventListener('message', async event => {
      if (currentState !== State.LISTENING) return;

      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (data.type !== 'Results') return;
      const transcript = data.channel?.alternatives?.[0]?.transcript || '';
      if (!transcript.trim()) return;

      if (data.is_final) {
        finalUtteranceParts.push(transcript.trim());
        interimUtterance = '';
        showTranscript(finalUtteranceParts.join(' '), 'final');

        if (data.speech_final && !isProcessing) {
          const completeUtterance = finalUtteranceParts.join(' ').trim();
          finalUtteranceParts = [];
          if (completeUtterance) await processUtterance(completeUtterance);
        }
      } else {
        interimUtterance = transcript.trim();
        showTranscript([...finalUtteranceParts, interimUtterance].join(' '), 'interim');
      }
    });

    deepgramSocket.addEventListener('error', () => {
      cleanupAudio();
      setState(State.ERROR);
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') alert('Accès au microphone refusé.');
    cleanupAudio();
    setState(State.ERROR);
  }
}

async function stopListening() {
  if (currentState !== State.LISTENING) return;

  const pendingText = [...finalUtteranceParts, interimUtterance].join(' ').trim();
  finalUtteranceParts = [];
  interimUtterance = '';
  cleanupAudio();

  if (pendingText && !isProcessing) await processUtterance(pendingText);
  else if (!isProcessing) {
    hideTranscript();
    setState(State.IDLE);
  }
}

async function processUtterance(userText) {
  if (isProcessing || !userText || !currentSimulationId) return;
  isProcessing = true;
  cleanupAudio();
  addMessage('user', userText);
  hideTranscript();

  const elapsed = simulationStartTime
    ? Math.floor((Date.now() - simulationStartTime) / 1000)
    : 0;

  fullTranscription.push({
    locuteur: 'commercial',
    texte: userText,
    horodatageSecondes: elapsed
  });

  setState(State.THINKING);

  try {
    const chatRes = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authAccessToken ? { Authorization: `Bearer ${authAccessToken}` } : {})
      },
      body: JSON.stringify({
        simulationId: currentSimulationId,
        userText,
        horodatageSecondes: elapsed
      })
    });

    const chatData = await chatRes.json();
    if (!chatRes.ok) throw new Error(chatData.error || `Chat API ${chatRes.status}`);

    const aiText = chatData.text;
    if (!aiText) throw new Error('Réponse vide du prospect');

    addMessage('ai', aiText);

    const elapsedAi = simulationStartTime
      ? Math.floor((Date.now() - simulationStartTime) / 1000)
      : elapsed;

    fullTranscription.push({
      locuteur: 'ia',
      texte: aiText,
      horodatageSecondes: elapsedAi
    });

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
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!ttsRes.ok) throw new Error(`Cartesia ${ttsRes.status}`);

  const arrayBuffer = await ttsRes.arrayBuffer();
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.75;

  const decodedData = await audioCtx.decodeAudioData(arrayBuffer);
  const source = audioCtx.createBufferSource();
  source.buffer = decodedData;
  source.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);
  if (recordingDestination) analyserNode.connect(recordingDestination);

  startVisualizer();
  source.start(0);

  await new Promise(resolve => {
    source.onended = () => {
      stopVisualizer();
      resolve();
    };
  });
}

function startVisualizer() {
  if (!analyserNode) return;
  audioViz.style.opacity = '1';
  const ctx = audioViz.getContext('2d');
  const bufLen = analyserNode.frequencyBinCount;
  const data = new Uint8Array(bufLen);
  const BARS = 28;
  const stride = Math.floor(bufLen / BARS);
  const W = audioViz.width;
  const H = audioViz.height;
  const gap = 3;
  const barW = (W - gap * (BARS - 1)) / BARS;

  function draw() {
    vizFrame = requestAnimationFrame(draw);
    analyserNode.getByteFrequencyData(data);
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < BARS; i++) {
      const val = data[i * stride] / 255;
      const barH = Math.max(4, val * H * 0.88);
      const x = i * (barW + gap);
      const y = (H - barH) / 2;
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
      if (deepgramSocket.readyState === WebSocket.OPEN) deepgramSocket.send(JSON.stringify({ type: 'CloseStream' }));
      deepgramSocket.close();
    } catch (_) {}
    deepgramSocket = null;
  }

  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  if (microphoneSource) {
    try { microphoneSource.disconnect(); } catch (_) {}
    microphoneSource = null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  UI HELPERS
// ════════════════════════════════════════════════════════════════════════════

function showTranscript(text, mode) {
  transcriptLive.textContent = text;
  transcriptLive.className = `transcript-live visible ${mode}`;
}

function hideTranscript() {
  transcriptLive.textContent = '';
  transcriptLive.className = 'transcript-live';
}

function addMessage(role, text) {
  if (convEmpty) convEmpty.style.display = 'none';
  const isUser = role === 'user';
  const userSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  const aiSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" x2="8" y1="16" y2="16"/><line x1="16" x2="16" y1="16" y2="16"/></svg>`;
  const el = document.createElement('div');
  el.className = `message ${role}`;
  el.innerHTML = `<div class="msg-avatar" aria-hidden="true">${isUser ? userSvg : aiSvg}</div><div class="msg-bubble">${escapeHtml(text)}</div>`;
  conversation.appendChild(el);
  requestAnimationFrame(() => conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'smooth' }));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const simulationId = params.get('simulationId');

  if (!token || !simulationId) return;

  window.history.replaceState({}, '', window.location.pathname);
  authAccessToken = token;

  fetch('/api/auth/login-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  })
    .then(async res => ({ ok: res.ok, data: await res.json() }))
    .then(async ({ ok, data }) => {
      if (!ok || !data.user) throw new Error(data.error || 'Authentification impossible');
      currentUser = data.user;
      currentProfile = data.profile;
      showApp();
      await loadSimulationContext(simulationId);
    })
    .catch(err => {
      console.warn('[Auth] Erreur token URL :', err.message);
      statusLabel.textContent = 'Impossible de charger la simulation.';
    });
});
