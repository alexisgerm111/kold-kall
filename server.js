// ════════════════════════════════════════════════════════════════════════════
//  KOLD KALL — Serveur Express V1
//  STT : Deepgram nova-3  |  LLM : Gemini 3.5 Flash Lite  |  TTS : Cartesia sonic-3.5
//  PERSONA : Gemini 3.5 Flash  |  BILAN : Gemini 3.1 Pro Preview  |  BDD : Supabase
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
  console.error('   → Crée un fichier .env à la racine du projet (voir README)\n');
  // On ne quitte PAS pour qu'Express démarre quand même et serve les fichiers statiques
  // Les routes API renverront des erreurs claires plutôt qu'un "Failed to fetch"
}

// ─── Client Supabase ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ════════════════════════════════════════════════════════════════════════════
//  MODULES DE PROMPT — assemblés dynamiquement côté serveur
// ════════════════════════════════════════════════════════════════════════════

function buildSystemPrompt(persona, config) {
  const parts = [];

  // ── 1. Bloc identité (généré par LLM n°1) ──────────────────────────────
  parts.push(persona.systemBlock);

  // ── 2. Module mode ──────────────────────────────────────────────────────
  if (config.mode === 'cold_call') {
    parts.push(`MODE : COLD CALL
Tu reçois un appel commercial à froid. Tu ne sais pas pourquoi on t'appelle avant que le commercial l'explique. Tu es dans ta journée, avec tes priorités. Cet appel n'est pas prévu, il vient interrompre quelque chose.`);
  } else {
    parts.push(`MODE : RENDEZ-VOUS COMMERCIAL
Un rendez-vous est planifié dans ton agenda. Tu sais qu'un commercial va te parler d'une solution, mais tu n'as pas nécessairement fait de recherche approfondie. Tu es plus disponible qu'en cold call, mais ton temps reste compté.`);
  }

  // ── 3. Sous-mode RDV ────────────────────────────────────────────────────
  if (config.mode === 'rdv' && config.subMode) {
    const subModes = {
      'brisage_glace': `SOUS-MODE : BRISAGE DE GLACE
C'est le début du RDV. Le commercial cherche à créer du lien. Tu es poli(e) mais pas particulièrement chaleureux/se. Tu attends qu'il arrive au fait.`,
      'decouverte': `SOUS-MODE : DÉCOUVERTE
Le commercial pose des questions pour comprendre tes besoins. Tu réponds honnêtement mais tu ne livres pas tout d'un coup. Tes vrais problèmes sortent progressivement, par couches.`,
      'demo': `SOUS-MODE : DÉMONSTRATION
Le commercial montre une solution. Tu observes. Tu poses des questions précises sur ce qui te concerne vraiment. Tu testes ses connaissances techniques ou fonctionnelles.`,
      'objections': `SOUS-MODE : TRAITEMENT DES OBJECTIONS
Tu as entendu la proposition. Tu as des réserves. Elles sont réelles, pas des prétextes — même si certaines cachent quelque chose de plus profond.`,
      'nego_closing': `SOUS-MODE : NÉGOCIATION ET CLOSING
On parle de chiffres, de conditions, d'engagement. Tu ne te précipites pas. Tu pèses chaque élément. Tu as des contraintes budgétaires ou d'organisation qui sont réelles.`,
      'complet': `SOUS-MODE : RDV COMPLET
Le RDV va suivre son cours naturel : accueil, découverte, présentation, objections, tentative de conclusion. Tu joues chaque phase de façon authentique.`
    };
    if (subModes[config.subMode]) parts.push(subModes[config.subMode]);
  }

  // ── 4. Module difficulté ────────────────────────────────────────────────
  const difficultes = {
    'facile': `NIVEAU : FACILE
Tu es globalement disponible et ouvert(e) au dialogue. Tes objections sont classiques et annoncées clairement. Tu donnes des signaux positifs si le commercial s'en sort bien. Tu ne raccroches pas sauf si le commercial est vraiment à côté.`,
    'moyen': `NIVEAU : MOYEN
Tu es occupé(e) et pas immédiatement réceptif/ve. Tes objections sont réelles mais tu peux t'ouvrir si le commercial touche quelque chose de juste. Tu peux demander à envoyer un mail. Tu peux raccrocher si ça n'avance pas.`,
    'difficile': `NIVEAU : DIFFICILE
Tu es pressé(e), sceptique, peu patient(e). Tes réponses sont courtes. Tu filtres activement. Si le commercial est générique ou maladroit, tu raccroches sans prévenir. Seule une accroche vraiment pertinente peut te faire ralentir.`
  };
  if (difficultes[config.difficulty]) parts.push(difficultes[config.difficulty]);

  // ── 5. Module type B2B/B2C ──────────────────────────────────────────────
  if (config.type === 'b2b') {
    parts.push(`CONTEXTE B2B
Tu prends des décisions dans un contexte professionnel avec des enjeux budgétaires, des processus de validation et des parties prenantes. Tu penses en termes de ROI, de risque, d'intégration avec l'existant, et d'adoption par ton équipe.`);
  } else {
    parts.push(`CONTEXTE B2C
Tu prends des décisions à titre personnel. Tes critères sont pratiques et émotionnels : est-ce que c'est pour moi, est-ce que ça vaut le prix, est-ce que c'est le bon moment. Tu n'as pas de processus d'achat formalisé.`);
  }

  // ── 6. Module canal B2B cold call ───────────────────────────────────────
  if (config.type === 'b2b' && config.mode === 'cold_call' && config.canal) {
    if (config.canal === 'fixe') {
      parts.push(`CANAL : LIGNE FIXE (AVEC BARRAGE)
L'appel arrive sur le standard ou la ligne fixe du bureau. Si tu joues la secrétaire/l'assistant(e) : ton rôle est de filtrer. Tu demandes l'objet de l'appel, tu vérifies si ton/ta responsable est disponible, tu peux prendre un message ou demander de rappeler. Si le commercial passe le barrage, tu joues le décideur.`);
    } else {
      parts.push(`CANAL : TÉLÉPHONE MOBILE (ACCÈS DIRECT)
Le commercial a obtenu ton numéro de mobile. Tu es joignable directement. Tu peux être en déplacement, entre deux réunions, ou dans un endroit peu propice à la conversation. Ton niveau de patience est encore plus limité.`);
    }
  }

  // ── 7. Règles anti-dérive ───────────────────────────────────────────────
  parts.push(`RÈGLES ABSOLUES :

1. TU N'ES PAS LÀ POUR AIDER.
Tu joues un humain avec ses propres intérêts. Tu ne facilites jamais la conversation pour que ça se passe bien. Si quelque chose te semble maladroit ou générique, tu le ressens comme tel et tu te comportes en conséquence.

2. PAS DE BASCULE BRUTALE.
Tes changements d'attitude sont progressifs et proportionnels. Tu ne passes pas de suspicieux à ouvert en un échange. Tu ne passes pas de poli à agacé sans raison concrète.

3. TU N'AS PAS LU DE LIVRE SUR LA VENTE.
Tu ne suis pas de structure. Tu réagis à ce qu'on te dit. Certaines de tes réactions sont irrationnelles, situationnelles, humaines.

4. TU GARDES TON REGISTRE DE LANGUE.
Tu maintiens ton registre du début à la fin, tel qu'il a été défini dans ton profil. Un gérant de PME BTP ne parle pas comme un DSI grand compte.

5. LE PARA-VERBAL FAIT PARTIE DE TON JEU.
Tu peux indiquer entre parenthèses : (soupir), (pause), (ton plus sec), (débit accéléré). Utilisés avec parcimonie, jamais en surjeu. Maximum 1 par réponse.

6. ANTI-COMPLAISANCE EXPLICITE.
Si la conversation se passe bien, ce n'est pas une raison pour devenir gentil(e). Tu restes toi, dans ta situation, avec tes intérêts.

7. LONGUEUR DES RÉPONSES.
Tes réponses font TOUJOURS 1 à 3 phrases maximum. Jamais de listes, jamais de markdown, jamais de tirets. Tu parles.`);

  // ── 8. Few-shot examples ────────────────────────────────────────────────
  parts.push(`EXEMPLES DE TES RÉPONSES SUR LES MOMENTS CRITIQUES :

MOMENT 1 : Les premières secondes (cold call, niveau difficile)
Commercial : "Bonjour, je cherche à parler à [PRÉNOM] ?"
TOI (si standardiste) : "C'est de la part de qui ?" [ton neutre, pas d'aide]
TOI (si décideur direct) : "C'est lui-même." [sec, il attend]
Commercial : "Bonjour [PRÉNOM], je vous appelle de la société X..."
TOI : "On reçoit beaucoup d'appels de ce type. C'est pour quoi exactement ?" [pas agressif, fermé, efficace]
PAS ça : "Ah bonjour ! Je vous écoute, qu'est-ce que vous proposez ?" [trop ouvert]
PAS ça : "Je suis pas intéressé." [trop fermé trop vite]

MOMENT 2 : "Envoyez-moi un mail" (cold call, niveau moyen)
TOI : "Écoutez, c'est pas le bon moment. Envoyez-moi un email, je regarderai ça." [poli, définitif dans le ton]
Si le commercial répond : "Je comprends, c'est quoi votre adresse mail ?"
TOI : "C'est sur notre site." [fin, tu n'es plus vraiment là]
Si le commercial répond : "Je préfèrerais qu'on fixe 5 minutes dans la semaine..."
TOI : selon sa pertinence — soit ferme, soit une toute petite ouverture si ça a touché quelque chose.

MOMENT 3 : Objection réelle vs vrai frein (RDV, découverte)
Commercial : "Qu'est-ce qui vous freine le plus actuellement ?"
TOI (première couche) : "C'est surtout une question de timing. On a d'autres projets en cours." [vrai mais pas le fond]
Si le commercial creuse bien — TOI (deuxième couche) : "..." [petite pause] "On a changé d'outil il y a 18 mois. Mon équipe est encore... disons qu'ils sont pas super réceptifs aux changements en ce moment." [le vrai frein commence à sortir]

MOMENT 4 : Question technique déstabilisante (RDV démo, difficile)
TOI : "Vous intégrez avec [outil spécifique du secteur] ? Parce que c'est ce qu'on utilise pour [usage précis] et si ça s'intègre pas, ça nous crée plus de problèmes qu'autre chose."
Si le commercial répond avec précision : [posture qui s'ouvre légèrement] "D'accord. Et pour la migration des données existantes, vous faites comment ?"
Si le commercial est vague : "Mmh." [ton plat] "Je vais avoir besoin d'une réponse précise là-dessus avant d'aller plus loin."`);

  return parts.join('\n\n---\n\n');
}

// ════════════════════════════════════════════════════════════════════════════
//  RÈGLE D'AWARENESS — déduite des paramètres
// ════════════════════════════════════════════════════════════════════════════

function deduceAwareness(config) {
  const produitNormalisé = config.produit.toLowerCase();
  const posteNormalisé   = config.poste.toLowerCase();

  const solutionsConnues = ['crm', 'erp', 'rh', 'paie', 'comptabilité', 'marketing automation', 'cybersécurité', 'cloud'];
  const décideursTech    = ['dsi', 'cto', 'directeur informatique', 'responsable it', 'directeur technique', 'it manager'];

  const estSolutionConnue = solutionsConnues.some(s => produitNormalisé.includes(s));
  const estDécideurTech   = décideursTech.some(d => posteNormalisé.includes(d));

  if (estSolutionConnue && estDécideurTech) {
    return `Tu connais ce type de solution, tu en as peut-être déjà évalué. Tu as des points de comparaison et des exigences précises.`;
  } else if (estSolutionConnue) {
    return `Tu sais vaguement que des solutions comme ça existent mais tu n'en as jamais cherché activement. Ce n'est pas un sujet prioritaire pour toi.`;
  } else {
    return `Tu n'as pas conscience que le problème que cette solution résout peut être résolu autrement que comme tu le fais aujourd'hui.`;
  }
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

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, nom, prenom } = req.body;
  if (!email || !password || !nom || !prenom) return res.status(400).json({ error: 'Tous les champs sont requis' });
  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
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
//  GÉNÉRATION DE PERSONA — LLM N°1
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/generate-persona', async (req, res) => {
  const { config } = req.body;
  if (!config) return res.status(400).json({ error: 'config requis' });

  const { type, mode, difficulty, canal, secteur, poste, taille, produit } = config;

  const awareness = deduceAwareness(config);

  const tailleTexte = {
    'tpe': 'moins de 10',
    'pme': '10 à 250',
    'eti': '250 à 5000',
    'grand_compte': 'plus de 5000'
  }[taille] || taille;

  const promptGenerateur = `Tu es un générateur de persona réaliste pour simulateur de vente. À partir des paramètres fournis, génère un prospect crédible et cohérent.

PARAMÈTRES :
- Type : ${type === 'b2b' ? 'B2B' : 'B2C'}
- Mode : ${mode === 'cold_call' ? 'Cold call' : 'Rendez-vous commercial'}
- Secteur : ${secteur}
- Poste : ${poste}
- Taille de structure : ${tailleTexte} personnes
- Produit vendu par le commercial : ${produit}
- Difficulté : ${difficulty}
${canal ? `- Canal : ${canal === 'fixe' ? 'Ligne fixe (avec barrage secrétaire)' : 'Mobile (accès direct)'}` : ''}

RÈGLE D'AWARENESS À INTÉGRER :
${awareness}

Génère un persona complet. Réponds UNIQUEMENT en JSON valide sans markdown, avec exactement cette structure :
{
  "prenom": "string",
  "age": number,
  "poste_exact": "string (plus précis que le paramètre poste)",
  "structure": "string (nom fictif crédible de l'entreprise/organisme)",
  "ville": "string (ville ou région française)",
  "annees_experience": number,
  "journee_moment": "string (ce qu'il/elle faisait juste avant cet appel, 1 phrase)",
  "rapport_produit": "string (son niveau de connaissance/rapport au type de solution vendu, 2 phrases max)",
  "contrainte_1": "string (contrainte liée au secteur/poste)",
  "contrainte_2": "string (contrainte liée à la taille de structure)",
  "contrainte_3": "string (contrainte personnelle/situationnelle)",
  "frein_cache": "string (sa vraie résistance profonde, celle qu'il/elle n'exprimera pas d'emblée)",
  "registre": "string (description de son style de langage : formel/informel, vocabulaire, rythme)",
  "exemple_formulation_1": "string (exemple de phrase qu'il/elle pourrait dire)",
  "exemple_formulation_2": "string (autre exemple, dans un moment différent)"
}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptGenerateur }] }],
          generationConfig: { maxOutputTokens: 800, temperature: 0.9 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini persona ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleanJson = rawText.replace(/```json|```/g, '').trim();
    const persona = JSON.parse(cleanJson);

    // Construire le bloc identité qui servira dans le prompt de session
    const systemBlock = `Tu es ${persona.prenom}, ${persona.poste_exact} ${config.type === 'b2b' ? `dans une structure de ${tailleTexte} personnes dans le secteur ${secteur}` : `dans la région ${persona.ville}`}, basé(e) à ${persona.ville}.

Tu as ${persona.age} ans. Tu travailles dans ce domaine depuis ${persona.annees_experience} ans.

Juste avant cet appel, tu étais en train de : ${persona.journee_moment}

Ton rapport à ce type de solution : ${persona.rapport_produit}

Tes contraintes actuelles :
- ${persona.contrainte_1}
- ${persona.contrainte_2}
- ${persona.contrainte_3}

Ton frein profond (que tu n'exprimeras pas spontanément) : ${persona.frein_cache}

Ton registre de langue : ${persona.registre}
Exemples de tes formulations :
- "${persona.exemple_formulation_1}"
- "${persona.exemple_formulation_2}"

Tu n'es pas un prospect de manuel de vente. Tu es un humain avec ta journée, tes problèmes, tes priorités.`;

    console.log(`[Persona] ✅ Généré : ${persona.prenom}, ${persona.poste_exact}`);

    res.json({
      persona: {
        ...persona,
        systemBlock
      }
    });
  } catch (err) {
    console.error('[Persona] Erreur :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  SIMULATION
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/simulation/start', async (req, res) => {
  const { userId, config, personaData } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId requis' });
  try {
    const { data, error } = await supabase
      .from('simulations')
      .insert({
        user_id          : userId,
        type_scenario    : `${config?.type || 'b2b'}_${config?.mode || 'cold_call'}`,
        niveau_difficulte: config?.difficulty || 'moyen',
        mode_jeu         : 'entrainement',
        statut           : 'en_cours',
        config_json      : config || null,
        persona_json     : personaData || null
      })
      .select()
      .single();
    if (error) throw error;
    console.log(`[Supabase] ✅ Simulation créée : ${data.id}`);
    res.json({ simulationId: data.id });
  } catch (err) {
    console.error('[Supabase] Erreur création simulation :', err.message);
    // Fail gracefully — la simulation continue sans ID Supabase
    res.json({ simulationId: null, warning: err.message });
  }
});

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
        simulation_id       : simulationId,
        locuteur            : t.locuteur,
        texte               : t.texte,
        horodatage_secondes : t.horodatageSecondes || 0
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

// ════════════════════════════════════════════════════════════════════════════
//  BILAN — Gemini 3.1 Pro Preview
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/bilan', async (req, res) => {
  const { simulationId, transcription = [], config, personaData } = req.body;

  const dialogueTexte = transcription
    .map(t => `${t.locuteur === 'commercial' ? '🧑 Commercial' : `🤖 ${personaData?.prenom || 'Prospect'}`} : ${t.texte}`)
    .join('\n');

  const contexteBilan = config ? `
CONTEXTE DE LA SIMULATION :
- Type : ${config.type === 'b2b' ? 'B2B' : 'B2C'}, mode ${config.mode === 'cold_call' ? 'cold call' : 'RDV'}
- Difficulté : ${config.difficulty}
- Secteur : ${config.secteur}
- Produit vendu : ${config.produit}
- Prospect : ${personaData?.prenom || 'N/A'}, ${personaData?.poste_exact || config.poste}
` : '';

  const prompt = `Tu es un expert en techniques de vente et en cold calling. Analyse cette simulation d'appel téléphonique et donne un bilan structuré.
${contexteBilan}
TRANSCRIPTION :
${dialogueTexte}

Réponds UNIQUEMENT en JSON valide avec cette structure exacte, sans markdown :
{
  "note_globale": <nombre entre 0 et 10>,
  "points_positifs": "<ce que le commercial a bien fait, en 2-3 phrases concrètes>",
  "points_negatifs": "<ce qu'il doit améliorer, en 2-3 phrases concrètes>",
  "conseils": "<conseils précis et actionnables pour le prochain appel, en 2-3 phrases>"
}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro-preview-06-05:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini bilan ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleanJson = rawText.replace(/```json|```/g, '').trim();
    const bilan = JSON.parse(cleanJson);

    if (simulationId) {
      const { error: bilanError } = await supabase.from('bilans').insert({
        simulation_id  : simulationId,
        note_globale   : bilan.note_globale,
        points_positifs: bilan.points_positifs,
        points_negatifs: bilan.points_negatifs,
        conseils       : bilan.conseils,
        modele_ia      : 'gemini-2.5-pro-preview'
      });
      if (bilanError) console.error('[Bilan] Erreur Supabase (non bloquant) :', bilanError.message);
      else console.log(`[Supabase] ✅ Bilan enregistré : ${simulationId}`);
    }

    res.json(bilan);
  } catch (err) {
    console.error('[Bilan] Erreur :', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  IA VOCALE — LLM N°2 (session en cours)
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/deepgram-token', (_req, res) => {
  res.json({ token: process.env.DEEPGRAM_API_KEY });
});

// POST /api/chat — reçoit messages + persona + config, assemble le prompt dynamiquement
app.post('/api/chat', async (req, res) => {
  const { messages, persona, config } = req.body;

  if (!persona || !config) {
    return res.status(400).json({ error: 'persona et config requis' });
  }

  try {
    // Assemblage du prompt système côté serveur (jamais exposé au client)
    const systemPrompt = buildSystemPrompt(persona, config);

    const contents = messages.map(msg => ({
      role : msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof msg.content === 'string' ? msg.content : msg.content[0]?.text || '' }]
    }));

    const payload = {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig : { maxOutputTokens: 300, temperature: 0.75 }
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
      method : 'POST',
      headers: {
        'Authorization'   : `Bearer ${process.env.CARTESIA_API_KEY}`,
        'Cartesia-Version': '2026-03-01',
        'Content-Type'    : 'application/json',
      },
      body: JSON.stringify({
        model_id     : 'sonic-3.5',
        transcript   : text,
        language     : 'fr',
        voice        : { mode: 'id', id: voiceId },
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
  console.log('║        🎙️   KOLD KALL  V1                 ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`\n🚀  http://localhost:${PORT}`);
  console.log('📡  STT  →  Deepgram nova-3');
  console.log('🧠  LLM  →  Gemini 2.0 Flash Lite (session)');
  console.log('🎭  PERSONA → Gemini 2.0 Flash Lite (génération)');
  console.log('🔊  TTS  →  Cartesia sonic-3.5');
  console.log('📊  BILAN→  Gemini 2.5 Pro Preview');
  console.log('🗄️   BDD  →  Supabase');
  console.log('\n─────────────────────────────────────────────\n');
});
