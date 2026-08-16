// ════════════════════════════════════════════════════════════════════════════
//  KOLD KALL — Serveur Express
//  STT : Deepgram nova-3  |  LLM : Gemini 3.5 Flash Lite  |  TTS : Cartesia sonic-3.5
//  BILAN : Gemini 3.1 Pro Preview  |  BDD : Supabase
// ════════════════════════════════════════════════════════════════════════════

import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Validation des variables d'environnement ──────────────────────────────
const REQUIRED = [
  'DEEPGRAM_API_KEY',
  'GEMINI_API_KEY',
  'CARTESIA_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_KEY'
];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`\n❌  Variables manquantes : ${missing.join(', ')}`);
  process.exit(1);
}

// ─── Client Supabase ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ════════════════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    const { data: profile } = await supabase.from('profiles').select('*').eq('id', data.user.id).single();
    res.json({ user: data.user, session: data.session, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, nom, prenom } = req.body;
  if (!email || !password || !nom || !prenom) return res.status(400).json({ error: 'Tous les champs sont requis' });
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { nom, prenom, role: 'commercial' } }
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ user: data.user, message: 'Compte créé. Vérifiez votre email pour confirmer.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Email de réinitialisation envoyé.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  SIMULATION
// ════════════════════════════════════════════════════════════════════════════

// POST /api/simulation/start
app.post('/api/simulation/start', async (req, res) => {
  const { userId, typeScenario = 'prospect_direct', niveauDifficulte = 'moyen', modeJeu = 'entrainement' } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requis' });
  try {
    const { data, error } = await supabase
      .from('simulations')
      .insert({ user_id: userId, type_scenario: typeScenario, niveau_difficulte: niveauDifficulte, mode_jeu: modeJeu, statut: 'en_cours' })
      .select()
      .single();
    if (error) throw error;
    console.log(`[Supabase] ✅ Simulation créée : ${data.id}`);
    res.json({ simulationId: data.id });
  } catch (err) {
    console.error('[Supabase] Erreur création simulation :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/simulation/end
app.post('/api/simulation/end', async (req, res) => {
  const { simulationId, dureeSecondes, transcription = [] } = req.body;
  if (!simulationId) return res.status(400).json({ error: 'simulationId requis' });
  try {
    const { error: simError } = await supabase
      .from('simulations')
      .update({ statut: 'terminee', duree_secondes: dureeSecondes })
      .eq('id', simulationId);
    if (simError) throw simError;

    if (transcription.length > 0) {
      const rows = transcription.map(t => ({
        simulation_id: simulationId,
        locuteur: t.locuteur,
        texte: t.texte,
        horodatage_secondes: t.horodatageSecondes || 0
      }));
      const { error: transError } = await supabase.from('transcriptions').insert(rows);
      if (transError) throw transError;
    }

    console.log(`[Supabase] ✅ Simulation terminée : ${simulationId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Supabase] Erreur clôture simulation :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bilan — Gemini 3.1 Pro Preview (modèle séparé, sans biais)
app.post('/api/bilan', async (req, res) => {
  const { simulationId, transcription = [] } = req.body;
  if (!simulationId) return res.status(400).json({ error: 'simulationId requis' });

  const dialogueTexte = transcription
    .map(t => `${t.locuteur === 'commercial' ? '🧑 Commercial' : '🤖 Prospect IA'} : ${t.texte}`)
    .join('\n');

  const prompt = `Tu es un expert en techniques de vente et en cold calling. Analyse cette simulation d'appel téléphonique et donne un bilan structuré.

TRANSCRIPTION :
${dialogueTexte}

Réponds UNIQUEMENT en JSON valide avec cette structure exacte, sans markdown :
{
  "note_globale": <nombre entre 0 et 10>,
  "points_positifs": "<ce que le commercial a bien fait, en 2-3 phrases>",
  "points_negatifs": "<ce qu'il doit améliorer, en 2-3 phrases>",
  "conseils": "<conseils concrets et actionnables, en 2-3 phrases>"
}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini 3.1 Pro Preview ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleanJson = rawText.replace(/```json|```/g, '').trim();
    const bilan = JSON.parse(cleanJson);

    const { error: bilanError } = await supabase.from('bilans').insert({
      simulation_id: simulationId,
      note_globale: bilan.note_globale,
      points_positifs: bilan.points_positifs,
      points_negatifs: bilan.points_negatifs,
      conseils: bilan.conseils,
      modele_ia: 'gemini-3.1-pro-preview'
    });
    if (bilanError) throw bilanError;

    console.log(`[Supabase] ✅ Bilan enregistré : ${simulationId}`);
    res.json(bilan);
  } catch (err) {
    console.error('[Bilan] Erreur :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  IA VOCALE
// ════════════════════════════════════════════════════════════════════════════

// GET /api/deepgram-token
app.get('/api/deepgram-token', (_req, res) => {
  res.json({ token: process.env.DEEPGRAM_API_KEY });
});

// POST /api/chat — Gemini 3.5 Flash Lite (vocal, temps réel)
app.post('/api/chat', async (req, res) => {
  const { messages, systemPrompt } = req.body;
  try {
    const contents = messages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof msg.content === 'string' ? msg.content : msg.content[0]?.text || '' }]
    }));

    const payload = {
      contents,
      generationConfig: { maxOutputTokens: 300, temperature: 0.7 }
    };
    if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Gemini] Erreur API :', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[Gemini] ← "${text.substring(0, 80)}${text.length > 80 ? '…' : ''}"`);
    res.json({ text });
  } catch (err) {
    console.error('[Gemini] Exception :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tts — Cartesia sonic-3.5
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  const voiceId = process.env.CARTESIA_VOICE_ID || 'a249eaff-1e96-4d2c-b23b-12efa4f66f41';
  try {
    const response = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CARTESIA_API_KEY}`,
        'Cartesia-Version': '2026-03-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'sonic-3.5',
        transcript: text,
        language: 'fr',
        voice: { mode: 'id', id: voiceId },
        output_format: { container: 'wav', encoding: 'pcm_f32le', sample_rate: 44100 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Cartesia] Erreur API :', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    const buffer = await response.arrayBuffer();
    console.log(`[Cartesia] Audio généré → ${(buffer.byteLength / 1024).toFixed(1)} KB`);
    res.set('Content-Type', 'audio/wav');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[Cartesia] Exception :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Démarrage ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║        🎙️   KOLD KALL  V0                 ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`\n🚀  http://localhost:${PORT}`);
  console.log('📡  STT  →  Deepgram nova-3');
  console.log('🧠  LLM  →  Gemini 3.5 Flash Lite');
  console.log('🔊  TTS  →  Cartesia sonic-3.5');
  console.log('📊  BILAN→  Gemini 3.1 Pro Preview');
  console.log('🗄️   BDD  →  Supabase');
  console.log('\n─────────────────────────────────────────────\n');
});