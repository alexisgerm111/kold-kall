// ════════════════════════════════════════════════════════════════════════════
//  KOLD KALL — Serveur Express
//  STT : Deepgram nova-3  |  LLM : Gemini 3.5 Flash Lite  |  TTS : Cartesia sonic-3.5
//  PERSONA + BILAN : Gemini 3.1 Pro Preview  |  BDD : Supabase
// ════════════════════════════════════════════════════════════════════════════

import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import dns from 'dns/promises';
import net from 'net';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── CORS Dashboard ──────────────────────────────────────────────────────────
const ALLOWED_CORS_ORIGINS = new Set([
  'https://alexisgerm111.github.io'
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_CORS_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Validation des variables d'environnement ──────────────────────────────
const REQUIRED = [
  'DEEPGRAM_API_KEY',
  'GEMINI_API_KEY',
  'CARTESIA_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'SUPABASE_SECRET_KEY'
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

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const preparingSimulationIds = new Set();

// ════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════════

async function getAuthenticatedUser(req) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return null;

  const token = authorization.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  return error || !data?.user ? null : data.user;
}

async function getProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  return error ? null : data;
}

async function getAuthorizedSimulation(req, simulationId) {
  const user = await getAuthenticatedUser(req);
  if (!user) return { error: { status: 401, message: 'Authentification requise' } };

  const { data: simulation, error: simulationError } = await supabaseAdmin
    .from('simulations')
    .select('*')
    .eq('id', simulationId)
    .single();

  if (simulationError || !simulation) {
    return { error: { status: 404, message: 'Simulation introuvable' } };
  }

  const profile = await getProfile(user.id);
  const isOwner = simulation.user_id === user.id;
  const isDirector = profile?.role === 'directeur';

  if (!isOwner && !isDirector) {
    return { error: { status: 403, message: 'Accès refusé' } };
  }

  return { user, profile, simulation };
}

function cleanJsonText(rawText) {
  return String(rawText || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function parseGeminiJson(rawText) {
  const cleaned = cleanJsonText(rawText);
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) {
      throw new Error('Réponse Gemini non JSON');
    }
    return JSON.parse(cleaned.slice(first, last + 1));
  }
}

async function callGemini(model, prompt, { maxOutputTokens = 4000, temperature = 0.2 } = {}) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens, temperature }
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini ${model} ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text.trim()) throw new Error(`Gemini ${model} n'a retourné aucun contenu`);
  return text;
}


const URL_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    type_entreprise: { type: 'string' },
    produit_service: { type: 'string' },
    faits_publics: { type: 'array', items: { type: 'string' } }
  },
  required: ['type_entreprise', 'produit_service', 'faits_publics']
};

const PERSONA_SCHEMA = {
  type: 'object',
  properties: {
    PERSONA_COMPLETE: {
      type: 'object',
      properties: {
        identite: { type: 'object' }, role_ou_profil: { type: 'string' }, contexte: { type: 'string' },
        faits_observables: { type: 'array', items: { type: 'string' } },
        hypotheses_scenario: { type: 'array', items: { type: 'string' } },
        situation_actuelle: { type: 'string' }, enjeux: { type: 'array', items: { type: 'string' } },
        probleme_principal: { type: 'string' }, problemes_secondaires: { type: 'array', items: { type: 'string' } },
        objectifs: { type: 'array', items: { type: 'string' } }, contraintes: { type: 'array', items: { type: 'string' } },
        motivations: { type: 'array', items: { type: 'string' } }, priorites: { type: 'array', items: { type: 'string' } },
        objections_potentielles: { type: 'array', items: { type: 'string' } }, criteres_decision: { type: 'array', items: { type: 'string' } },
        niveau_urgence: { type: 'number' }, niveau_ouverture_initiale: { type: 'number' }, attitude_initiale: { type: 'string' },
        niveau_confiance_initial: { type: 'number' }, informations_connues: { type: 'array', items: { type: 'string' } },
        informations_inconnues: { type: 'array', items: { type: 'string' } }, informations_revelables: { type: 'array', items: { type: 'string' } },
        reactions_probables: { type: 'object' }, memoire_simulation_precedente: { type: 'object' }, point_de_depart_conversation: { type: 'string' }
      },
      required: ['identite','role_ou_profil','contexte','faits_observables','hypotheses_scenario','situation_actuelle','enjeux','probleme_principal','problemes_secondaires','objectifs','contraintes','motivations','priorites','objections_potentielles','criteres_decision','niveau_urgence','niveau_ouverture_initiale','attitude_initiale','niveau_confiance_initial','informations_connues','informations_inconnues','informations_revelables','reactions_probables','memoire_simulation_precedente','point_de_depart_conversation']
    },
    PROSPECT_VISIBLE_CONTEXT: {
      type: 'object',
      properties: {
        identite: { type: 'object' }, role_ou_profil: { type: 'string' }, contexte: { type: 'string' },
        informations_connues_au_demarrage: { type: 'array', items: { type: 'string' } }, situation: { type: 'string' },
        objectifs_connus: { type: 'array', items: { type: 'string' } }, attitude_initiale: { type: 'string' },
        niveau_ouverture: { type: 'number' }, niveau_confiance: { type: 'number' },
        memoire_des_echanges_precedents: { type: 'array', items: { type: 'string' } },
        seller_known: { type: 'boolean' }, seller_company_known: { type: 'boolean' }, seller_product_known: { type: 'boolean' }, call_reason_known: { type: 'boolean' }
      },
      required: ['identite','role_ou_profil','contexte','informations_connues_au_demarrage','situation','objectifs_connus','attitude_initiale','niveau_ouverture','niveau_confiance','memoire_des_echanges_precedents','seller_known','seller_company_known','seller_product_known','call_reason_known']
    }
  },
  required: ['PERSONA_COMPLETE', 'PROSPECT_VISIBLE_CONTEXT']
};

const BILAN_SCHEMA = {
  type: 'object',
  properties: {
    comportements_naturels: { type: 'array', items: { type: 'object', properties: {
      horodatage_secondes: { type: 'number' }, description: { type: 'string' },
      frameworks_associes: { type: 'array', items: { type: 'string' } }, niveau_certitude: { type: 'number' }, principe_nomme: { type: 'string' }
    }, required: ['horodatage_secondes','description','frameworks_associes','niveau_certitude','principe_nomme'] } },
    ecarts: { type: 'array', items: { type: 'object', properties: {
      horodatage_secondes: { type: 'number' }, type: { type: 'string', enum: ['adaptatif','instinctif','manquant'] }, description: { type: 'string' },
      effet_avant: { type: 'string' }, effet_apres: { type: 'string' }, framework_de_reference: { type: 'string' }
    }, required: ['horodatage_secondes','type','description','effet_avant','effet_apres','framework_de_reference'] } },
    moments_bascule: { type: 'array', items: { type: 'object', properties: {
      horodatage_secondes: { type: 'number' }, declencheur: { type: 'string' }, description: { type: 'string' }
    }, required: ['horodatage_secondes','declencheur','description'] } },
    coherence_interne: { type: 'object', properties: {
      comportements_ancres: { type: 'array', items: { type: 'string' } }, comportements_situationnels: { type: 'array', items: { type: 'string' } }, incoherences: { type: 'array', items: { type: 'string' } }
    }, required: ['comportements_ancres','comportements_situationnels','incoherences'] },
    distribution_tactique: { type: 'object', properties: {
      questions: { type: 'number' }, crac: { type: 'number' }, storytelling: { type: 'number' }, reframe: { type: 'number' }, autres: { type: 'number' }
    }, required: ['questions','crac','storytelling','reframe','autres'] },
    attribution_multi_framework: { type: 'array', items: { type: 'object', properties: {
      comportement: { type: 'string' }, frameworks: { type: 'array', items: { type: 'string' } }, interpretation: { type: 'string' }
    }, required: ['comportement','frameworks','interpretation'] } },
    tagline: { type: 'string' }, note_globale: { type: 'number' }
  },
  required: ['comportements_naturels','ecarts','moments_bascule','coherence_interne','distribution_tactique','attribution_multi_framework','tagline','note_globale']
};

async function callGeminiStructured(model, prompt, schema, { maxOutputTokens = 4000, temperature = 0.2 } = {}) {
  console.log(`[Gemini] → ${model} | structured JSON`);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens,
          temperature,
          responseFormat: { text: { mimeType: 'application/json', schema } }
        }
      })
    }
  );
  if (!response.ok) {
    const errText = await response.text();
    console.error(`[Gemini] ${model} HTTP ${response.status}: ${errText.slice(0, 1500)}`);
    throw new Error(`Gemini ${model} ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text.trim()) {
    console.error(`[Gemini] ${model} réponse vide :`, JSON.stringify(data).slice(0, 1500));
    throw new Error(`Gemini ${model} n'a retourné aucun contenu`);
  }
  try { return JSON.parse(text); }
  catch (error) {
    console.error(`[Gemini] ${model} JSON invalide malgré structured output :`, text.slice(0, 1500));
    throw new Error(`Réponse Gemini JSON invalide : ${error.message}`);
  }
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function detectObjection(text) {
  return /(pas le temps|pas interesse|trop cher|trop couteux|deja un prestataire|deja equipe|pas besoin|on verra plus tard|envoyez[- ]moi|concurrence|concurrent)/i.test(normalizeText(text));
}

function detectBuyingSignal(text) {
  return /(interessant|ca pourrait|on pourrait envisager|dans notre budget|quand est-ce qu'on pourrait|vous avez des references|comment ca se passe ensuite|quelle est la prochaine etape)/i.test(normalizeText(text));
}

function detectClosingAttempt(text) {
  return /(on bloque|on part sur|on signe|signer|signature|contrat|prochaine etape|je vous envoie|on reserve|vous pouvez valider|on finalise)/i.test(normalizeText(text));
}

function detectPhaseForText(text) {
  const normalized = normalizeText(text);
  if (/(signature|signer|contrat|prochaine etape|on bloque|on part sur|je vous envoie le contrat|budget final)/i.test(normalized)) return 'closing';
  if (detectObjection(normalized)) return 'objection';
  if (/(notre solution|notre produit|voici|voila|comment ca marche|fonctionne|demonstration|demo|fonctionnalite)/i.test(normalized)) return 'pitch';
  return 'decouverte';
}

function classifyQuestion(question) {
  const normalized = normalizeText(question).trim();
  const ouverte = /^(comment|pourquoi|qu'est-ce que|qu est-ce que|quoi|de quelle facon|en quoi|dans quelle mesure|quel impact)/i.test(normalized);
  const fermee = /^(est-ce que|est ce que|avez-vous|avez vous|etes-vous|etes vous|pouvez-vous|pouvez vous|faites-vous|faites vous|vous avez|vous etes)/i.test(normalized);

  let type = 'qualification';
  if (/(impact|cout|consequence|perte|probleme)/i.test(normalized)) type = 'impact';
  else if (/(et si|imaginez|supposons|hypothese)/i.test(normalized)) type = 'autopersuasion';
  else if (/(combien|budget|depuis quand|quel montant|combien de personnes)/i.test(normalized)) type = 'qualification';
  else if (/(ca correspond|cela correspond|ca vous convient|cela vous convient|d'accord pour)/i.test(normalized)) type = 'validation';

  return { ouverte: ouverte && !fermee, fermee: fermee || !ouverte, type };
}

function detectSecondaryTags(transcription) {
  const allText = transcription.map(item => item.texte || '').join(' ');
  const tags = [];
  if (transcription.some(item => item.locuteur === 'ia' && detectObjection(item.texte))) tags.push('Objections');
  if (transcription.some(item => item.locuteur === 'ia' && detectBuyingSignal(item.texte))) tags.push('Closing');
  if (transcription.some(item => item.locuteur === 'commercial' && /\?/.test(item.texte || ''))) tags.push('Découverte');
  if (/(demo|demonstration|fonctionnalite|fonctionnalité)/i.test(normalizeText(allText))) tags.push('Démo');
  return [...new Set(tags)];
}

function mapSimulationTypeToTags(typeSimulation) {
  const mapping = {
    cold_call: ['Cold Call & Prospection'],
    decouverte: ['Découverte'],
    demo: ['Démo'],
    objections_closing: ['Objections', 'Closing'],
    nego: ['Closing'],
    rdv_complet: ['rdv_complet']
  };
  return mapping[typeSimulation] || ['Autre'];
}

async function getRelevantReportSections(typeSimulation, detectedTags) {
  const allTags = [...new Set([...mapSimulationTypeToTags(typeSimulation), ...(detectedTags || [])])];
  const { data, error } = await supabaseAdmin
    .from('rapports')
    .select('titre, contenu, tags, source')
    .overlaps('tags', allTags);
  if (error) {
    console.error('[Rapports] Erreur récupération :', error.message);
    return [];
  }

  let total = 0;
  const limited = [];
  for (const section of data || []) {
    const size = String(section.contenu || '').length;
    if (total + size > 60000) break;
    limited.push(section);
    total += size;
  }
  return limited;
}

function analyzeQuantitative(transcription) {
  const turns = Array.isArray(transcription)
    ? [...transcription].sort((a, b) => (a.horodatage_secondes || 0) - (b.horodatage_secondes || 0))
    : [];

  const commercialTurns = turns.filter(t => t.locuteur === 'commercial');
  const prospectTurns = turns.filter(t => t.locuteur === 'ia' || t.locuteur === 'prospect');

  const commercialWords = commercialTurns.reduce((sum, t) => sum + wordCount(t.texte), 0);
  const prospectWords = prospectTurns.reduce((sum, t) => sum + wordCount(t.texte), 0);
  const totalWords = commercialWords + prospectWords;

  let nbQuestionsTotal = 0;
  let nbQuestionsOuvertes = 0;
  let nbQuestionsFermees = 0;
  let nbQuestionsImpact = 0;
  let nbQuestionsAutopersuasion = 0;
  let nbQuestionsQualification = 0;
  let nbQuestionsValidation = 0;

  commercialTurns.forEach(turn => {
    const questions = String(turn.texte || '').match(/[^?]+(?=\?)/g) || [];
    nbQuestionsTotal += questions.length;
    questions.forEach(question => {
      const classification = classifyQuestion(question);
      if (classification.ouverte) nbQuestionsOuvertes++;
      else nbQuestionsFermees++;
      if (classification.type === 'impact') nbQuestionsImpact++;
      else if (classification.type === 'autopersuasion') nbQuestionsAutopersuasion++;
      else if (classification.type === 'validation') nbQuestionsValidation++;
      else nbQuestionsQualification++;
    });
  });

  const affirmations = commercialTurns.reduce((count, turn) => count + (/\?/.test(turn.texte || '') ? 0 : 1), 0);
  const ratioQuestionsAffirmations = (nbQuestionsTotal + affirmations) > 0
    ? (nbQuestionsTotal / (nbQuestionsTotal + affirmations)) * 100
    : 0;

  let nbObjectionsTotal = 0;
  let nbObjectionsResolues = 0;
  prospectTurns.forEach(turn => {
    if (!detectObjection(turn.texte)) return;
    nbObjectionsTotal++;
    const start = Number(turn.horodatage_secondes) || 0;
    const nextThree = turns.filter(item => (Number(item.horodatage_secondes) || 0) > start).slice(0, 3);
    if (!nextThree.some(item => (item.locuteur === 'ia' || item.locuteur === 'prospect') && detectObjection(item.texte))) {
      nbObjectionsResolues++;
    }
  });

  let nbInterruptions = 0;
  let nbSilencesLaisses = 0;
  let nbSilencesRemplis = 0;
  for (let i = 1; i < turns.length; i++) {
    const previous = turns[i - 1];
    const current = turns[i];
    const delta = (Number(current.horodatage_secondes) || 0) - (Number(previous.horodatage_secondes) || 0);
    if ((previous.locuteur === 'ia' || previous.locuteur === 'prospect') && current.locuteur === 'commercial' && delta <= 2) nbInterruptions++;
    if (delta > 3) {
      if (previous.locuteur === 'commercial' && (current.locuteur === 'ia' || current.locuteur === 'prospect')) nbSilencesLaisses++;
      if ((previous.locuteur === 'ia' || previous.locuteur === 'prospect') && current.locuteur === 'commercial') nbSilencesRemplis++;
    }
  }

  const longueurMoyenne = turns.length
    ? turns.reduce((sum, turn) => sum + wordCount(turn.texte), 0) / turns.length
    : 0;

  let nbSignauxAchat = 0;
  let nbSignauxExploites = 0;
  const closingDelays = [];
  prospectTurns.forEach(signal => {
    if (!detectBuyingSignal(signal.texte)) return;
    nbSignauxAchat++;
    const start = Number(signal.horodatage_secondes) || 0;
    const attempt = commercialTurns.find(turn => (Number(turn.horodatage_secondes) || 0) > start && detectClosingAttempt(turn.texte));
    if (attempt) {
      nbSignauxExploites++;
      closingDelays.push((Number(attempt.horodatage_secondes) || 0) - start);
    }
  });

  const duration = turns.reduce((max, turn) => Math.max(max, Number(turn.horodatage_secondes) || 0), 0);
  const bins = Array.from({ length: 10 }, () => ({ long: 0, short: 0, signals: 0, total: 0 }));
  prospectTurns.forEach(turn => {
    const ratio = duration > 0 ? (Number(turn.horodatage_secondes) || 0) / duration : 0;
    const binIndex = Math.min(9, Math.max(0, Math.floor(ratio * 10)));
    const words = wordCount(turn.texte);
    bins[binIndex].total++;
    if (words > 20) bins[binIndex].long++;
    else bins[binIndex].short++;
    if (detectBuyingSignal(turn.texte)) bins[binIndex].signals++;
  });

  const engagementScores = bins.map(bin => {
    const longRatio = bin.total > 0 ? bin.long / bin.total : 0;
    const signalRatio = bin.total > 0 ? bin.signals / bin.total : 0;
    return Math.round(Math.min(100, longRatio * 70 + Math.min(1, signalRatio * 2) * 30));
  });

  const mean = engagementScores.reduce((sum, n) => sum + n, 0) / engagementScores.length;
  const variance = engagementScores.reduce((sum, n) => sum + Math.pow(n - mean, 2), 0) / engagementScores.length;
  const deviation = Math.sqrt(variance);
  let momentBasculeSecondes = null;
  for (let i = 0; i < engagementScores.length - 1; i++) {
    if (engagementScores[i] >= mean + deviation && engagementScores[i + 1] >= engagementScores[i] * 0.8) {
      momentBasculeSecondes = Math.floor((duration / 10) * i);
      break;
    }
  }

  return {
    ratio_parole_commercial: totalWords ? Number(((commercialWords / totalWords) * 100).toFixed(2)) : 0,
    ratio_parole_prospect: totalWords ? Number(((prospectWords / totalWords) * 100).toFixed(2)) : 0,
    nb_questions_total: nbQuestionsTotal,
    nb_questions_ouvertes: nbQuestionsOuvertes,
    nb_questions_fermees: nbQuestionsFermees,
    ratio_questions_affirmations: Number(ratioQuestionsAffirmations.toFixed(2)),
    nb_questions_impact: nbQuestionsImpact,
    nb_questions_autopersuasion: nbQuestionsAutopersuasion,
    nb_questions_qualification: nbQuestionsQualification,
    nb_questions_validation: nbQuestionsValidation,
    nb_objections_total: nbObjectionsTotal,
    nb_objections_resolues: nbObjectionsResolues,
    taux_resolution_objections: nbObjectionsTotal ? Number(((nbObjectionsResolues / nbObjectionsTotal) * 100).toFixed(2)) : 0,
    nb_interruptions: nbInterruptions,
    nb_silences_laisses: nbSilencesLaisses,
    nb_silences_remplis: nbSilencesRemplis,
    longueur_moyenne_prise_parole: Number(longueurMoyenne.toFixed(2)),
    nb_signaux_achat: nbSignauxAchat,
    nb_signaux_exploites: nbSignauxExploites,
    delai_moyen_closing_apres_signal: closingDelays.length ? Number((closingDelays.reduce((a, b) => a + b, 0) / closingDelays.length).toFixed(2)) : 0,
    moment_bascule_secondes: momentBasculeSecondes,
    score_engagement_final: engagementScores.at(-1) || 0
  };
}

async function saveQuantitativeMetrics(simulationId, metrics) {
  await supabaseAdmin.from('metriques').delete().eq('simulation_id', simulationId);
  const { error } = await supabaseAdmin.from('metriques').insert({ simulation_id: simulationId, ...metrics });
  if (error) throw error;
}

function isPositiveAppointmentOutcome(transcription) {
  const lastProspectTurns = transcription
    .filter(item => item.locuteur === 'ia' || item.locuteur === 'prospect')
    .slice(-4)
    .map(item => item.texte || '');

  return lastProspectTurns.some(text => /(d'accord|oui|avec plaisir|pourquoi pas|on peut|rendez-vous|disponible|calons|bloquons|prochain rendez-vous)/i.test(text));
}

function isValidPhaseTransition(previousSimulation, targetPhase, previousTranscription) {
  if (!previousSimulation || previousSimulation.type_entretien !== 'rdv' && previousSimulation.type_entretien !== 'cold_call') return false;

  if (previousSimulation.type_entretien === 'cold_call') {
    if (!['complet', 'decouverte'].includes(targetPhase)) return false;
    return isPositiveAppointmentOutcome(previousTranscription || []);
  }

  const previousPhase = previousSimulation.phase_choisie;
  if (targetPhase === 'complet') return ['decouverte', 'demo', 'objections_closing', 'nego'].includes(previousPhase);
  if (targetPhase === 'decouverte') return previousPhase === 'complet';
  if (targetPhase === 'demo') return previousPhase === 'decouverte';
  if (targetPhase === 'objections_closing') return previousPhase === 'demo';
  if (targetPhase === 'nego') return previousPhase === 'objections_closing';
  return false;
}

function sanitizeWebsiteText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 30000);
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return false;
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (_) { throw new Error('URL invalide'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Seules les URL HTTP/HTTPS sont autorisées');
  if (parsed.username || parsed.password) throw new Error('URL avec identifiants interdite');

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '0.0.0.0') throw new Error('Hôte local interdit');
  if (net.isIP(hostname) && isPrivateIp(hostname)) throw new Error('Adresse IP privée interdite');

  if (!net.isIP(hostname)) {
    const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!resolved.length || resolved.some(item => isPrivateIp(item.address))) throw new Error('Domaine non public');
  }
  return parsed.toString();
}

async function fetchPublicPageText(rawUrl) {
  let currentUrl = await assertPublicUrl(rawUrl);
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirection sans destination');
      currentUrl = await assertPublicUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (!response.ok) throw new Error(`Le site a répondu HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) throw new Error('L URL fournie ne pointe pas vers une page HTML');

    const html = await response.text();
    const clean = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");

    return { url: currentUrl, texte: sanitizeWebsiteText(clean) };
  }
  throw new Error('Trop de redirections');
}

async function analyzePublicUrl(rawUrl, cible, context = {}) {
  const page = await fetchPublicPageText(rawUrl);
  const prompt = `
Tu extrais uniquement des informations publiques observables depuis une page web.
Tu ne dois jamais inventer un problème interne, un budget, une organisation cachée ou une information privée.

CIBLE : ${cible}
CONTEXTE : ${JSON.stringify(context, null, 2)}
URL : ${page.url}
CONTENU PUBLIC :
${page.texte}

Réponds uniquement en JSON strict :
{
  "type_entreprise": "",
  "produit_service": "",
  "type_entreprise_prospect": "",
  "faits_publics": []
}
`;
  console.log(`[URL] Analyse Gemini → ${cible} | ${page.url} | ${page.texte.length} caractères`);
  const result = await callGeminiStructured('gemini-3.1-pro-preview', prompt, URL_ANALYSIS_SCHEMA, { maxOutputTokens: 1500, temperature: 0.1 });
  return {
    type_entreprise: result.type_entreprise || result.type_entreprise_prospect || '',
    produit_service: result.produit_service || '',
    type_entreprise_prospect: result.type_entreprise_prospect || result.type_entreprise || '',
    faits_publics: Array.isArray(result.faits_publics) ? result.faits_publics : []
  };
}

async function buildSimulationPersona({ simulationContext, previousSimulation, previousTranscriptions }) {
  let previousContext = null;
  if (previousSimulation) {
    const { data: previousBilan } = await supabaseAdmin
      .from('bilans')
      .select('analyse_qualitative')
      .eq('simulation_id', previousSimulation.id)
      .maybeSingle();

    previousContext = {
      simulation: previousSimulation,
      persona_complete: previousSimulation.persona_complete,
      prospect_visible_context: previousSimulation.prospect_visible_context,
      transcription: previousTranscriptions,
      analyse_qualitative: previousBilan?.analyse_qualitative || null
    };
  }

  const prompt = `
Tu es l'architecte de scénario de Kold Kall.

Modèle : Gemini 3.1 Pro Preview.

MISSION
Construire un prospect dynamique pour UNE simulation commerciale.

IMPORTANT
- Tu construis un scénario de simulation, pas une vérité sur une entreprise réelle.
- Les informations publiques peuvent être conservées comme faits observables.
- Les problèmes internes non observables sont des hypothèses plausibles de scénario.
- Le produit du vendeur ne doit jamais imposer artificiellement le problème du prospect.

CONTEXTE COMPLET :
${JSON.stringify(simulationContext, null, 2)}

SIMULATION PRÉCÉDENTE :
${JSON.stringify(previousContext, null, 2)}

RÈGLE COLD CALL
Au démarrage, le prospect ne connaît ni le vendeur, ni son entreprise, ni son produit, ni la raison réelle de l'appel. Il découvre ces éléments uniquement lorsqu'ils sont révélés.

RÈGLE RDV
Le prospect connaît le contexte prévu du rendez-vous. Il connaît notamment qui il rencontre, l'entreprise du vendeur, le produit/service et pourquoi le rendez-vous existe. S'il s'agit d'une continuation, il conserve ce qu'il a réellement appris auparavant.

RÈGLE CONTINUITÉ
- Même personne.
- Aucun fait contradictoire.
- Ne jamais ajouter rétroactivement une information comme si elle avait toujours été connue.
- Conserver problèmes, objectifs, objections, engagements et état relationnel pertinents.

Sépare strictement :
1. PERSONA_COMPLETE : tout ce que le moteur et l'analyste peuvent savoir.
2. PROSPECT_VISIBLE_CONTEXT : uniquement ce que le prospect peut connaître au démarrage.

Réponds uniquement avec ce JSON :
{
  "PERSONA_COMPLETE": {
    "identite": {},
    "role_ou_profil": "",
    "contexte": "",
    "faits_observables": [],
    "hypotheses_scenario": [],
    "situation_actuelle": "",
    "enjeux": [],
    "probleme_principal": "",
    "problemes_secondaires": [],
    "objectifs": [],
    "contraintes": [],
    "motivations": [],
    "priorites": [],
    "objections_potentielles": [],
    "criteres_decision": [],
    "niveau_urgence": 0,
    "niveau_ouverture_initiale": 0,
    "attitude_initiale": "",
    "niveau_confiance_initial": 0,
    "informations_connues": [],
    "informations_inconnues": [],
    "informations_revelables": [],
    "reactions_probables": {},
    "memoire_simulation_precedente": {},
    "point_de_depart_conversation": ""
  },
  "PROSPECT_VISIBLE_CONTEXT": {
    "identite": {},
    "role_ou_profil": "",
    "contexte": "",
    "informations_connues_au_demarrage": [],
    "situation": "",
    "objectifs_connus": [],
    "attitude_initiale": "",
    "niveau_ouverture": 0,
    "niveau_confiance": 0,
    "memoire_des_echanges_precedents": [],
    "seller_known": false,
    "seller_company_known": false,
    "seller_product_known": false,
    "call_reason_known": false
  }
}
`;

  const result = await callGeminiStructured('gemini-3.1-pro-preview', prompt, PERSONA_SCHEMA, { maxOutputTokens: 6000, temperature: 0.25 });
  if (!result.PERSONA_COMPLETE || !result.PROSPECT_VISIBLE_CONTEXT) {
    throw new Error('Gemini n a pas retourné les deux niveaux de contexte');
  }

  if (simulationContext.type_entretien === 'cold_call') {
    result.PROSPECT_VISIBLE_CONTEXT.seller_known = false;
    result.PROSPECT_VISIBLE_CONTEXT.seller_company_known = false;
    result.PROSPECT_VISIBLE_CONTEXT.seller_product_known = false;
    result.PROSPECT_VISIBLE_CONTEXT.call_reason_known = false;
  }

  return {
    persona_complete: result.PERSONA_COMPLETE,
    prospect_visible_context: result.PROSPECT_VISIBLE_CONTEXT
  };
}

async function persistMicroComportements({ simulationId, userId, transcription, analyse }) {
  await supabaseAdmin.from('micro_comportements').delete().eq('simulation_id', simulationId);
  const rows = [];

  const findPhaseAtTimestamp = timestamp => {
    const nearest = transcription
      .filter(item => (Number(item.horodatage_secondes) || 0) <= timestamp)
      .at(-1);
    return nearest ? detectPhaseForText(nearest.texte) : 'decouverte';
  };

  (analyse.comportements_naturels || []).forEach(item => {
    rows.push({
      simulation_id: simulationId,
      user_id: userId,
      horodatage_secondes: Number(item.horodatage_secondes) || 0,
      comportement: item.description || '',
      type_ecart: 'adaptatif',
      frameworks_matches: item.frameworks_associes || [],
      effet_avant: '',
      effet_apres: '',
      phase: findPhaseAtTimestamp(Number(item.horodatage_secondes) || 0),
      est_moment_bascule: false
    });
  });

  (analyse.ecarts || []).forEach(item => {
    rows.push({
      simulation_id: simulationId,
      user_id: userId,
      horodatage_secondes: Number(item.horodatage_secondes) || 0,
      comportement: item.description || '',
      type_ecart: ['adaptatif', 'instinctif', 'manquant'].includes(item.type) ? item.type : 'manquant',
      frameworks_matches: item.framework_de_reference ? [item.framework_de_reference] : [],
      effet_avant: item.effet_avant || '',
      effet_apres: item.effet_apres || '',
      phase: findPhaseAtTimestamp(Number(item.horodatage_secondes) || 0),
      est_moment_bascule: false
    });
  });

  (analyse.moments_bascule || []).forEach(item => {
    rows.push({
      simulation_id: simulationId,
      user_id: userId,
      horodatage_secondes: Number(item.horodatage_secondes) || 0,
      comportement: `${item.declencheur || ''} ${item.description || ''}`.trim(),
      type_ecart: 'adaptatif',
      frameworks_matches: [],
      effet_avant: '',
      effet_apres: '',
      phase: findPhaseAtTimestamp(Number(item.horodatage_secondes) || 0),
      est_moment_bascule: true
    });
  });

  if (!rows.length) return;
  const { error } = await supabaseAdmin.from('micro_comportements').insert(rows);
  if (error) throw error;
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════════════════

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

app.post('/api/auth/login-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requis' });
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Token invalide ou expiré' });
    const profile = await getProfile(data.user.id);
    res.json({ user: data.user, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
//  ANALYSE URL
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/analyze-url', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Authentification requise' });

  const { url, cible, b2b_b2c, prospect_role } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requise' });
  if (!['vendeur', 'prospect'].includes(cible)) return res.status(400).json({ error: 'cible invalide' });

  try {
    const result = await analyzePublicUrl(url, cible, { b2b_b2c, prospect_role });
    res.json(result);
  } catch (err) {
    console.error('[URL] Erreur analyse :', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  SIMULATION
// ════════════════════════════════════════════════════════════════════════════

function buildSimulationContextFromRow(simulation) {
  return {
    b2b_b2c: simulation.b2b_b2c,
    type_entretien: simulation.type_entretien,
    phase_choisie: simulation.phase_choisie,
    vendeur: {
      type_entreprise: simulation.vendeur_type_entreprise || '',
      produit: simulation.vendeur_produit || '',
      url: simulation.vendeur_url || ''
    },
    prospect: {
      role: simulation.b2b_b2c === 'b2b' ? simulation.prospect_role || '' : null,
      type_entreprise: simulation.b2b_b2c === 'b2b' ? simulation.prospect_type_entreprise || '' : null,
      url: simulation.b2b_b2c === 'b2b' ? simulation.prospect_url || '' : null,
      profile: simulation.b2b_b2c === 'b2c' ? simulation.prospect_profile || '' : null
    },
    simulation_precedente_id: simulation.simulation_precedente_id,
    continuite_rdv: simulation.continuite_rdv
  };
}

async function prepareSimulationById(simulationId) {
  if (preparingSimulationIds.has(simulationId)) return;
  preparingSimulationIds.add(simulationId);

  try {
    const { data: simulation, error: simulationError } = await supabaseAdmin
      .from('simulations').select('*').eq('id', simulationId).single();
    if (simulationError || !simulation) throw new Error('Simulation introuvable pendant la préparation');
    if (simulation.statut !== 'preparation' || simulation.persona_complete) return;

    let workingSimulation = simulation;
    const enrichment = {};

    if (workingSimulation.vendeur_url && (!workingSimulation.vendeur_type_entreprise || !workingSimulation.vendeur_produit)) {
      console.log(`[URL] Enrichissement vendeur en arrière-plan : ${workingSimulation.vendeur_url}`);
      const seller = await analyzePublicUrl(workingSimulation.vendeur_url, 'vendeur', { b2b_b2c: workingSimulation.b2b_b2c });
      if (!workingSimulation.vendeur_type_entreprise && seller.type_entreprise) enrichment.vendeur_type_entreprise = seller.type_entreprise;
      if (!workingSimulation.vendeur_produit && seller.produit_service) enrichment.vendeur_produit = seller.produit_service;
    }

    if (workingSimulation.b2b_b2c === 'b2b' && workingSimulation.prospect_url && !workingSimulation.prospect_type_entreprise) {
      console.log(`[URL] Enrichissement prospect en arrière-plan : ${workingSimulation.prospect_url}`);
      const prospect = await analyzePublicUrl(workingSimulation.prospect_url, 'prospect', { b2b_b2c: workingSimulation.b2b_b2c, prospect_role: workingSimulation.prospect_role });
      if (prospect.type_entreprise_prospect) enrichment.prospect_type_entreprise = prospect.type_entreprise_prospect;
    }

    if (Object.keys(enrichment).length) {
      const { data: updated, error: updateError } = await supabaseAdmin
        .from('simulations').update(enrichment).eq('id', simulationId).select('*').single();
      if (updateError) throw updateError;
      workingSimulation = updated;
    }

    let previousSimulation = null;
    let previousTranscriptions = [];
    if (workingSimulation.simulation_precedente_id) {
      const { data: previous, error: previousError } = await supabaseAdmin
        .from('simulations').select('*').eq('id', workingSimulation.simulation_precedente_id).single();
      if (previousError || !previous) throw new Error('Simulation précédente introuvable pendant la préparation');

      const { data: previousRows, error: previousRowsError } = await supabaseAdmin
        .from('transcriptions').select('locuteur, texte, horodatage_secondes')
        .eq('simulation_id', previous.id).order('horodatage_secondes', { ascending: true });
      if (previousRowsError) throw previousRowsError;
      previousSimulation = previous;
      previousTranscriptions = previousRows || [];
    }

    const { persona_complete, prospect_visible_context } = await buildSimulationPersona({
      simulationContext: buildSimulationContextFromRow(workingSimulation),
      previousSimulation,
      previousTranscriptions
    });

    const { error: readyError } = await supabaseAdmin
      .from('simulations')
      .update({ persona_complete, prospect_visible_context, statut: 'en_cours' })
      .eq('id', simulationId)
      .eq('statut', 'preparation');
    if (readyError) throw readyError;

    console.log(`[Supabase] ✅ Persona prête : ${simulationId}`);
  } catch (err) {
    console.error(`[Simulation] ❌ Préparation ${simulationId} :`, err.stack || err.message);
    await supabaseAdmin.from('simulations').update({ statut: 'erreur_preparation' }).eq('id', simulationId).eq('statut', 'preparation');
  } finally {
    preparingSimulationIds.delete(simulationId);
  }
}

function ensureSimulationPreparation(simulationId) { void prepareSimulationById(simulationId); }

app.post('/api/simulation/start', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Authentification requise' });

  const {
    b2b_b2c, vendeur_type_entreprise, vendeur_produit, vendeur_url,
    prospect_role, prospect_type_entreprise, prospect_url, prospect_profile,
    type_entretien, phase_choisie = null, simulation_precedente_id = null, continuite_rdv = null
  } = req.body;

  if (!['b2b', 'b2c'].includes(b2b_b2c)) return res.status(400).json({ error: 'b2b_b2c invalide' });
  if (!['cold_call', 'rdv'].includes(type_entretien)) return res.status(400).json({ error: 'type_entretien invalide' });
  if (type_entretien === 'rdv' && !['complet','decouverte','demo','objections_closing','nego'].includes(phase_choisie)) return res.status(400).json({ error: 'phase_choisie invalide' });
  if (type_entretien === 'cold_call' && phase_choisie) return res.status(400).json({ error: 'Un Cold Call ne possède pas de phase supplémentaire' });

  let previousSimulation = null;
  let previousTranscriptions = [];
  if (simulation_precedente_id) {
    const { data: previous, error: previousError } = await supabaseAdmin
      .from('simulations').select('*').eq('id', simulation_precedente_id).single();
    if (previousError || !previous) return res.status(400).json({ error: 'Simulation précédente introuvable' });
    if (previous.user_id !== user.id) return res.status(403).json({ error: "La simulation précédente n'appartient pas à cet utilisateur" });
    if (previous.statut !== 'terminee') return res.status(400).json({ error: 'La simulation précédente doit être terminée' });
    if (previous.b2b_b2c && previous.b2b_b2c !== b2b_b2c) return res.status(400).json({ error: 'Le type B2B/B2C doit rester identique pour une continuation' });

    const { data: previousRows, error: previousRowsError } = await supabaseAdmin
      .from('transcriptions').select('locuteur, texte, horodatage_secondes')
      .eq('simulation_id', previous.id).order('horodatage_secondes', { ascending: true });
    if (previousRowsError) return res.status(500).json({ error: previousRowsError.message });
    previousSimulation = previous;
    previousTranscriptions = previousRows || [];

    if (type_entretien !== 'rdv' || !isValidPhaseTransition(previous, phase_choisie, previousTranscriptions)) return res.status(400).json({ error: 'Transition commerciale incompatible' });
    if (previous.type_entretien === 'cold_call') {
      if (continuite_rdv && continuite_rdv !== 'nouveau_rdv') return res.status(400).json({ error: 'Cette continuation doit être un nouveau rendez-vous' });
    } else if (continuite_rdv && !['meme_rdv','nouveau_rdv'].includes(continuite_rdv)) {
      return res.status(400).json({ error: 'continuite_rdv invalide' });
    }
  }

  try {
    const { data, error } = await supabaseAdmin.from('simulations').insert({
      user_id: user.id,
      type_scenario: type_entretien === 'cold_call' ? 'cold_call' : phase_choisie,
      niveau_difficulte: 'moyen', mode_jeu: 'entrainement', statut: 'preparation',
      type_entretien, phase_choisie, b2b_b2c,
      vendeur_type_entreprise: vendeur_type_entreprise?.trim() || null,
      vendeur_produit: vendeur_produit?.trim() || null,
      vendeur_url: vendeur_url?.trim() || null,
      prospect_role: b2b_b2c === 'b2b' ? prospect_role || null : null,
      prospect_type_entreprise: b2b_b2c === 'b2b' ? prospect_type_entreprise?.trim() || null : null,
      prospect_url: b2b_b2c === 'b2b' ? prospect_url?.trim() || null : null,
      prospect_profile: b2b_b2c === 'b2c' ? prospect_profile?.trim() || null : null,
      simulation_precedente_id: simulation_precedente_id || null,
      continuite_rdv: continuite_rdv || null
    }).select('id').single();

    if (error) throw error;
    console.log(`[Supabase] ✅ Simulation créée immédiatement : ${data.id}`);
    res.json({ simulationId: data.id, status: 'preparation' });
    ensureSimulationPreparation(data.id);
  } catch (err) {
    console.error('[Simulation] Erreur création :', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/simulation/context', async (req, res) => {
  const { simulationId } = req.query;
  if (!simulationId) return res.status(400).json({ error: 'simulationId requis' });

  const authorized = await getAuthorizedSimulation(req, simulationId);
  if (authorized.error) return res.status(authorized.error.status).json({ error: authorized.error.message });
  const { simulation } = authorized;

  if (simulation.statut === 'erreur_preparation') return res.status(500).json({ error: 'La préparation du scénario a échoué. Consulte les logs Render pour le détail.' });
  if (simulation.statut === 'preparation' || !simulation.prospect_visible_context || !simulation.persona_complete) {
    ensureSimulationPreparation(simulationId);
    return res.status(202).json({ ready: false, status: 'preparation' });
  }

  res.json({
    ready: true,
    simulation: {
      id: simulation.id,
      type_entretien: simulation.type_entretien,
      phase_choisie: simulation.phase_choisie,
      b2b_b2c: simulation.b2b_b2c,
      continuite_rdv: simulation.continuite_rdv,
      type_scenario: simulation.type_scenario
    },
    prospect_visible_context: simulation.prospect_visible_context
  });
});

app.get('/api/simulation/:simulationId/audio', async (req, res) => {
  const authorized = await getAuthorizedSimulation(req, req.params.simulationId);
  if (authorized.error) return res.status(authorized.error.status).json({ error: authorized.error.message });

  const { simulation } = authorized;
  if (!simulation.url_audio) return res.status(404).json({ error: 'Audio non disponible' });

  try {
    const pathMatch = simulation.url_audio.match(/simulation-audio\/(.+?)(?:\?|$)/);
    const objectPath = pathMatch?.[1] || `${simulation.user_id}/${simulation.id}.webm`;
    const { data, error } = await supabaseAdmin.storage
      .from('simulation-audio')
      .createSignedUrl(decodeURIComponent(objectPath), 60 * 60);

    if (error) throw error;
    res.json({ signedUrl: data.signedUrl });
  } catch (err) {
    console.error('[Audio] Erreur signed URL :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/simulation/end', async (req, res) => {
  const { simulationId, dureeSecondes, transcription = [], audioBase64 = null } = req.body;
  if (!simulationId) return res.status(400).json({ error: 'simulationId requis' });

  const authorized = await getAuthorizedSimulation(req, simulationId);
  if (authorized.error) return res.status(authorized.error.status).json({ error: authorized.error.message });

  try {
    const { simulation } = authorized;

    const { error: simError } = await supabaseAdmin
      .from('simulations')
      .update({ statut: 'terminee', duree_secondes: dureeSecondes })
      .eq('id', simulationId);
    if (simError) throw simError;

    await supabaseAdmin.from('transcriptions').delete().eq('simulation_id', simulationId);

    if (transcription.length > 0) {
      const rows = transcription.map(t => ({
        simulation_id: simulationId,
        locuteur: t.locuteur === 'prospect' ? 'ia' : t.locuteur,
        texte: t.texte,
        horodatage_secondes: t.horodatageSecondes || 0
      }));
      const { error: transError } = await supabaseAdmin.from('transcriptions').insert(rows);
      if (transError) throw transError;
    }

    if (audioBase64) {
      const cleanBase64 = audioBase64.replace(/^data:audio\/[^;]+;base64,/, '');
      const audioBuffer = Buffer.from(cleanBase64, 'base64');
      const audioPath = `${simulation.user_id}/${simulationId}.webm`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from('simulation-audio')
        .upload(audioPath, audioBuffer, {
          contentType: 'audio/webm',
          cacheControl: '3600',
          upsert: true
        });
      if (uploadError) throw uploadError;

      const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin.storage
        .from('simulation-audio')
        .createSignedUrl(audioPath, 60 * 60 * 24 * 365);
      if (signedUrlError) throw signedUrlError;

      const { error: audioDbError } = await supabaseAdmin
        .from('simulations')
        .update({ url_audio: signedUrlData.signedUrl })
        .eq('id', simulationId);
      if (audioDbError) throw audioDbError;
    }

    const { data: finalTranscription, error: finalTranscriptionError } = await supabaseAdmin
      .from('transcriptions')
      .select('locuteur, texte, horodatage_secondes')
      .eq('simulation_id', simulationId)
      .order('horodatage_secondes', { ascending: true });
    if (finalTranscriptionError) throw finalTranscriptionError;

    await saveQuantitativeMetrics(simulationId, analyzeQuantitative(finalTranscription || []));

    console.log(`[Supabase] ✅ Simulation terminée : ${simulationId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Supabase] Erreur clôture simulation :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  METRIQUES
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/metriques', async (req, res) => {
  const { simulationId } = req.body;
  if (!simulationId) return res.status(400).json({ error: 'simulationId requis' });

  const authorized = await getAuthorizedSimulation(req, simulationId);
  if (authorized.error) return res.status(authorized.error.status).json({ error: authorized.error.message });

  try {
    const { data: transcription, error } = await supabaseAdmin
      .from('transcriptions')
      .select('locuteur, texte, horodatage_secondes')
      .eq('simulation_id', simulationId)
      .order('horodatage_secondes', { ascending: true });
    if (error) throw error;

    const metrics = analyzeQuantitative(transcription || []);
    await saveQuantitativeMetrics(simulationId, metrics);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  BILAN
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/bilan', async (req, res) => {
  const { simulationId, surAttributionScore = 50 } = req.body;
  if (!simulationId) return res.status(400).json({ error: 'simulationId requis' });

  const authorized = await getAuthorizedSimulation(req, simulationId);
  if (authorized.error) return res.status(authorized.error.status).json({ error: authorized.error.message });

  const { simulation } = authorized;
  const sensitivity = Math.max(0, Math.min(100, Number(surAttributionScore) || 50));

  try {
    const { data: transcription, error: transcriptionError } = await supabaseAdmin
      .from('transcriptions')
      .select('locuteur, texte, horodatage_secondes')
      .eq('simulation_id', simulationId)
      .order('horodatage_secondes', { ascending: true });
    if (transcriptionError) throw transcriptionError;

    let { data: metriques } = await supabaseAdmin
      .from('metriques')
      .select('*')
      .eq('simulation_id', simulationId)
      .maybeSingle();

    if (!metriques) {
      metriques = analyzeQuantitative(transcription || []);
      await saveQuantitativeMetrics(simulationId, metriques);
    }

    const detectedTags = detectSecondaryTags(transcription || []);
    const typeSimulation = simulation.type_entretien === 'cold_call'
      ? 'cold_call'
      : simulation.phase_choisie === 'complet'
        ? 'rdv_complet'
        : simulation.phase_choisie;

    const relevantSections = await getRelevantReportSections(typeSimulation, detectedTags);

    let previousSimulationContext = null;
    if (simulation.simulation_precedente_id) {
      const { data: previousSimulation } = await supabaseAdmin
        .from('simulations')
        .select('id, type_entretien, phase_choisie, continuite_rdv, persona_complete, prospect_visible_context')
        .eq('id', simulation.simulation_precedente_id)
        .single();

      if (previousSimulation) {
        const { data: previousTranscription } = await supabaseAdmin
          .from('transcriptions')
          .select('locuteur, texte, horodatage_secondes')
          .eq('simulation_id', simulation.simulation_precedente_id)
          .order('horodatage_secondes', { ascending: true });
        previousSimulationContext = { simulation: previousSimulation, transcription: previousTranscription || [] };
      }
    }

    const dialogueTexte = (transcription || [])
      .map(t => `${t.locuteur === 'commercial' ? '🧑 Commercial' : '🤖 Prospect IA'} : ${t.texte}`)
      .join('\n');

    const simulationContext = {
      id: simulation.id,
      type_entretien: simulation.type_entretien,
      phase_choisie: simulation.phase_choisie,
      b2b_b2c: simulation.b2b_b2c,
      vendeur: {
        type_entreprise: simulation.vendeur_type_entreprise,
        produit: simulation.vendeur_produit,
        url: simulation.vendeur_url
      },
      prospect: {
        role: simulation.prospect_role,
        type_entreprise: simulation.prospect_type_entreprise,
        url: simulation.prospect_url,
        profile: simulation.prospect_profile
      },
      continuite_rdv: simulation.continuite_rdv
    };

    const prompt = `
Tu es un analyste expert en techniques de vente commerciale. Tu vas analyser la transcription d'une simulation d'entretien commercial en appliquant les 12 principes suivants.

PARAMÈTRE DE SENSIBILITÉ : ${sensitivity}/100
- En dessous de 30 : ne signaler une correspondance avec un framework QUE si le comportement est immédiatement reconnaissable par tout formateur expérimenté. Aucune interprétation.
- Entre 30 et 70 : correspondances solides uniquement, avec justification.
- Au-dessus de 70 : correspondances larges acceptées, avec mention explicite du niveau de certitude.

SECTIONS DE RÉFÉRENCE :
${JSON.stringify(relevantSections, null, 2)}

TRANSCRIPTION :
${dialogueTexte}

MÉTRIQUES QUANTITATIVES DÉJÀ CALCULÉES :
${JSON.stringify(metriques, null, 2)}

CONTEXTE COMPLET DE LA SIMULATION :
${JSON.stringify(simulationContext, null, 2)}

PERSONA DU PROSPECT :
${JSON.stringify(simulation.persona_complete, null, 2)}

HISTORIQUE ANTÉRIEUR SI LA SIMULATION EST UNE CONTINUATION :
${JSON.stringify(previousSimulationContext, null, 2)}

ANALYSE À PRODUIRE (JSON strict, sans markdown) :
{
  "comportements_naturels": [
    {
      "horodatage_secondes": 0,
      "description": "",
      "frameworks_associes": [],
      "niveau_certitude": 0,
      "principe_nomme": ""
    }
  ],
  "ecarts": [
    {
      "horodatage_secondes": 0,
      "type": "adaptatif",
      "description": "",
      "effet_avant": "",
      "effet_apres": "",
      "framework_de_reference": ""
    }
  ],
  "moments_bascule": [
    {
      "horodatage_secondes": 0,
      "declencheur": "",
      "description": ""
    }
  ],
  "coherence_interne": {
    "comportements_ancres": [],
    "comportements_situationnels": [],
    "incoherences": []
  },
  "distribution_tactique": {
    "questions": 0,
    "crac": 0,
    "storytelling": 0,
    "reframe": 0,
    "autres": 0
  },
  "attribution_multi_framework": [
    {
      "comportement": "",
      "frameworks": [],
      "interpretation": ""
    }
  ],
  "tagline": "",
  "note_globale": 0
}

RÈGLES IMPÉRATIVES :
1. Ne jamais écrire « il utilise [framework] ». Décrire d'abord le comportement observable.
2. Comparer les auteurs entre eux quand c'est pertinent.
3. Respecter le niveau de sensibilité demandé.
4. Mettre en avant les convergences multi-framework.
5. Toujours horodater les moments clés.
6. La tagline doit être distinctive et non générique.
7. Ne jamais inventer un comportement absent de la transcription.
8. Pour les moments de bascule, distinguer l'action du commercial et la réaction observable du prospect.
9. La note globale doit être comprise entre 0 et 100.
10. Les écarts sont classés adaptatif / instinctif / manquant.
11. La distribution tactique doit totaliser 100 à quelques arrondis près.
12. Ne jamais attribuer un framework uniquement sur un mot-clé.
`;

    const analyse = await callGeminiStructured('gemini-3.1-pro-preview', prompt, BILAN_SCHEMA, { maxOutputTokens: 7000, temperature: 0.2 });

    const note = Math.max(0, Math.min(100, Number(analyse.note_globale) || 0));
    analyse.note_globale = note;

    const positiveDescriptions = (analyse.comportements_naturels || []).slice(0, 5).map(item => item.description).filter(Boolean).join('\n');
    const negativeDescriptions = (analyse.ecarts || []).slice(0, 5).map(item => item.description).filter(Boolean).join('\n');
    const conseils = (analyse.ecarts || []).slice(0, 5).map(item => `À corriger : ${item.description}`).filter(Boolean).join('\n');

    const { data: existingBilan } = await supabaseAdmin
      .from('bilans')
      .select('id')
      .eq('simulation_id', simulationId)
      .maybeSingle();

    const payload = {
      simulation_id: simulationId,
      note_globale: note,
      points_positifs: positiveDescriptions || 'Aucun point positif identifié.',
      points_negatifs: negativeDescriptions || 'Aucun écart identifié.',
      conseils: conseils || 'Aucun conseil supplémentaire.',
      modele_ia: 'gemini-3.1-pro-preview',
      analyse_qualitative: analyse
    };

    if (existingBilan?.id) {
      const { error } = await supabaseAdmin.from('bilans').update(payload).eq('id', existingBilan.id);
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin.from('bilans').insert(payload);
      if (error) throw error;
    }

    await persistMicroComportements({ simulationId, userId: simulation.user_id, transcription: transcription || [], analyse });

    console.log(`[Supabase] ✅ Bilan enregistré : ${simulationId}`);
    res.json({ ...analyse, simulationId });
  } catch (err) {
    console.error('[Bilan] Erreur :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  IA VOCALE
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/deepgram-token', (_req, res) => {
  res.json({ token: process.env.DEEPGRAM_API_KEY });
});

app.post('/api/chat', async (req, res) => {
  const { simulationId, userText, horodatageSecondes = 0 } = req.body;
  if (!simulationId || !userText) return res.status(400).json({ error: 'simulationId et userText requis' });

  const authorized = await getAuthorizedSimulation(req, simulationId);
  if (authorized.error) return res.status(authorized.error.status).json({ error: authorized.error.message });

  const { simulation } = authorized;
  if (simulation.statut !== 'en_cours' || !simulation.persona_complete || !simulation.prospect_visible_context) {
    return res.status(409).json({ error: 'Simulation encore en préparation' });
  }

  try {
    const { data: previousRows, error: historyError } = await supabaseAdmin
      .from('transcriptions')
      .select('locuteur, texte, horodatage_secondes')
      .eq('simulation_id', simulationId)
      .order('horodatage_secondes', { ascending: true });
    if (historyError) throw historyError;

    const history = previousRows || [];
    history.push({ locuteur: 'commercial', texte: userText, horodatage_secondes: horodatageSecondes });

    const contents = history.map(turn => ({
      role: turn.locuteur === 'commercial' ? 'user' : 'model',
      parts: [{ text: turn.texte }]
    }));

    const visibleContext = simulation.prospect_visible_context || {};
    const coldCall = simulation.type_entretien === 'cold_call';

    const systemPrompt = `
Tu joues UNIQUEMENT le rôle du prospect de la simulation Kold Kall.
Tu parles naturellement en français.
Tes réponses font TOUJOURS 1 à 3 phrases maximum.
Pas de markdown. Pas de liste. Pas d'explication de raisonnement. Pas de mention du système, de Gemini ou de Kold Kall.

CONTEXTE AUTORISÉ :
${JSON.stringify(visibleContext, null, 2)}

${coldCall ? `COLD CALL : au démarrage, tu ne connais pas l'identité du vendeur, son entreprise, son produit ni la raison réelle de l'appel. Tu les apprends uniquement lorsqu'ils sont révélés dans la conversation.` : `RENDEZ-VOUS : tu connais le contexte prévu du rendez-vous et les informations effectivement apprises lors des simulations précédentes.`}

Tu réagis à ce que fait réellement le commercial.
Ne révèle pas spontanément toutes tes informations.
Fais sortir les informations progressivement.
Ne force jamais une objection.
Ne récite jamais le problème supposé du produit.
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { maxOutputTokens: 300 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Gemini] Erreur API :', response.status, errText);
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text.trim()) throw new Error('Gemini n a retourné aucune réponse');

    const { error: commercialInsertError } = await supabaseAdmin.from('transcriptions').insert({
      simulation_id: simulationId,
      locuteur: 'commercial',
      texte: userText,
      horodatage_secondes: horodatageSecondes
    });
    if (commercialInsertError) throw commercialInsertError;

    const { error: prospectInsertError } = await supabaseAdmin.from('transcriptions').insert({
      simulation_id: simulationId,
      locuteur: 'ia',
      texte: text,
      horodatage_secondes: horodatageSecondes
    });
    if (prospectInsertError) throw prospectInsertError;

    console.log(`[Gemini] ← "${text.substring(0, 80)}${text.length > 80 ? '…' : ''}"`);
    res.json({ text });
  } catch (err) {
    console.error('[Gemini] Exception :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text requis' });

  const voiceId = process.env.CARTESIA_VOICE_ID || 'a249eaff-1e96-4d2c-b23b-12efa4f66f41';
  try {
    const response = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CARTESIA_API_KEY}`,
        'Cartesia-Version': '2026-03-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model_id: 'sonic-3.5',
        transcript: text,
        language: 'fr',
        voice: { mode: 'id', id: voiceId },
        output_format: { container: 'wav', encoding: 'pcm_f32le', sample_rate: 44100 }
      })
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
  console.log('║        🎙️   KOLD KALL  V1                 ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`\n🚀  http://localhost:${PORT}`);
  console.log('📡  STT  →  Deepgram nova-3');
  console.log('🧠  LLM  →  Gemini 3.5 Flash Lite');
  console.log('🔊  TTS  →  Cartesia sonic-3.5');
  console.log('📊  BILAN→  Gemini 3.1 Pro Preview');
  console.log('🗄️   BDD  →  Supabase');
  console.log('\n─────────────────────────────────────────────\n');
});
