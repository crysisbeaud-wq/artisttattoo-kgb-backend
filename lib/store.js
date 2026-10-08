/**
 * lib/store.js
 * ---------------------------------------------------------------------------
 * Stockage des accès (qui a payé quoi), des résultats d'examen et du
 * compteur de visites.
 *
 * DEUX MODES, choisis automatiquement :
 *
 *  1. Base de données Upstash Redis (mode normal)
 *     Activé dès que Vercel fournit KV_REST_API_URL et KV_REST_API_TOKEN
 *     (créées en connectant la base « kgb-donnees » au projet).
 *     Les données sont PERMANENTES : elles survivent aux redémarrages et
 *     aux redéploiements.
 *
 *  2. Fichier temporaire /tmp (mode de secours)
 *     Utilisé seulement si la base n'est pas connectée. Le site continue
 *     de fonctionner, mais les données peuvent disparaître au prochain
 *     redémarrage de Vercel — exactement comme avant.
 *
 * MIGRATION AUTOMATIQUE : la première fois qu'un courriel est consulté,
 * s'il n'est pas encore dans la base mais figure dans access.json (à la
 * racine du dépôt), sa fiche y est recopiée. Rien à faire à la main.
 *
 * Les courriels sont comparés sans tenir compte des majuscules :
 * « Jean@Gmail.com » et « jean@gmail.com » désignent la même personne.
 *
 * Les certificats PDF ne sont plus stockés : ils sont reconstruits à la
 * demande à partir du résultat d'examen, qui lui est conservé.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const SEED_FILE = path.join(__dirname, '..', 'access.json');

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_JETON = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const MODE_BASE = Boolean(REDIS_URL && REDIS_JETON);

if (!MODE_BASE) {
  console.warn(
    'store.js : base de données non connectée (KV_REST_API_URL / KV_REST_API_TOKEN absents). ' +
    'Mode de secours /tmp : les données ne sont PAS permanentes.'
  );
}

// ===========================================================================
// Outils communs
// ===========================================================================

function defaultAccessRecord() {
  return {
    debutant: false,
    intermediaire: false,
    expert: false,
    pack_complet: false,
    session_live: false,
    tattoo_pass_hebdo: false,
    tattoo_pass_mensuel: false,
    tattoo_pass_annuel: false,
  };
}

function normaliser(email) {
  return String(email || '').trim().toLowerCase();
}

/** Calcule le nouveau résultat d'examen à partir du précédent. */
function fusionnerResultat(precedent, score, passed, nom) {
  return {
    score,
    passed,
    date: new Date().toISOString(),
    // On ne perd pas un nom déjà connu si la reprise n'en fournit pas
    nom: (nom && String(nom).trim())
      ? String(nom).trim()
      : (precedent && precedent.nom) || null,
    // Une réussite reste acquise, même si l'élève refait l'examen et échoue
    dejaReussi: Boolean(passed || (precedent && precedent.dejaReussi)),
  };
}

/** Forme publique d'un résultat, telle que server.js l'attend. */
function presenterResultat(resultat) {
  if (!resultat) return null;
  return {
    score: resultat.score,
    passed: Boolean(resultat.passed || resultat.dejaReussi),
    date: resultat.date || null,
    nom: resultat.nom || null,
  };
}

/** Lit access.json (la « graine ») et cherche un courriel sans tenir compte des majuscules. */
function ficheDansGraine(email) {
  try {
    if (!fs.existsSync(SEED_FILE)) return null;
    const tout = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8') || '{}');
    const cible = normaliser(email);
    const cle = Object.keys(tout).find((k) => normaliser(k) === cible);
    return cle ? tout[cle] : null;
  } catch (err) {
    console.error('Lecture de access.json impossible :', err.message);
    return null;
  }
}

function lireJson(texte) {
  if (texte === null || texte === undefined) return null;
  try { return JSON.parse(texte); } catch (e) { return texte; }
}

// ===========================================================================
// MODE 1 — Base de données Upstash Redis (API REST, sans librairie)
// ===========================================================================

async function redis(...commande) {
  const reponse = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_JETON}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commande.map((x) => String(x))),
  });

  let donnees = {};
  try { donnees = await reponse.json(); } catch (e) { /* réponse vide ou illisible */ }

  if (!reponse.ok || donnees.error) {
    throw new Error(`Base de données (${commande[0]}) : ${donnees.error || 'HTTP ' + reponse.status}`);
  }
  return donnees.result;
}

const cleAcces = (email) => `acces:${normaliser(email)}`;
const cleExamen = (email, formation) => `examen:${normaliser(email)}:${formation}`;
const CLE_COMPTEUR = 'compteur:visites';

// Courriels déjà vérifiés dans cette instance (évite de relire access.json à chaque appel)
const dejaVerifies = new Set();

/** Recopie dans la base la fiche d'un client présent dans access.json, une seule fois. */
async function assurerMigration(email) {
  const e = normaliser(email);
  if (!e || dejaVerifies.has(e)) return;

  const existe = Number(await redis('EXISTS', cleAcces(e)));
  if (!existe) {
    const graine = ficheDansGraine(e);
    if (graine) {
      const champs = [];
      Object.keys(graine).forEach((k) => {
        if (k === 'examens') return;
        champs.push(k, JSON.stringify(graine[k]));
      });
      if (champs.length) await redis('HSET', cleAcces(e), ...champs);

      const examens = graine.examens || {};
      for (const formation of Object.keys(examens)) {
        const deja = await redis('GET', cleExamen(e, formation));
        if (!deja) await redis('SET', cleExamen(e, formation), JSON.stringify(examens[formation]));
      }
      console.log(`Migration : fiche de ${e} recopiée depuis access.json.`);
    }
  }
  dejaVerifies.add(e);
}

async function base_getAccess(email) {
  await assurerMigration(email);
  const brut = await redis('HGETALL', cleAcces(email));
  const fiche = defaultAccessRecord();

  // Upstash renvoie HGETALL sous forme de liste [champ, valeur, champ, valeur…]
  if (Array.isArray(brut)) {
    for (let i = 0; i + 1 < brut.length; i += 2) fiche[brut[i]] = lireJson(brut[i + 1]);
  } else if (brut && typeof brut === 'object') {
    Object.keys(brut).forEach((k) => { fiche[k] = lireJson(brut[k]); });
  }
  return fiche;
}

async function base_setAccess(email, formationKey, value = true) {
  await assurerMigration(email);
  // HSET ne touche qu'un champ : deux achats simultanés ne s'écrasent pas
  await redis('HSET', cleAcces(email), formationKey, JSON.stringify(value));
  dejaVerifies.add(normaliser(email));
  return base_getAccess(email);
}

async function base_saveExamResult(email, formationKey, score, passed, nom) {
  await assurerMigration(email);
  const precedent = lireJson(await redis('GET', cleExamen(email, formationKey)));
  const nouveau = fusionnerResultat(precedent, score, passed, nom);
  await redis('SET', cleExamen(email, formationKey), JSON.stringify(nouveau));
  return nouveau;
}

async function base_getExamResult(email, formationKey) {
  await assurerMigration(email);
  return presenterResultat(lireJson(await redis('GET', cleExamen(email, formationKey))));
}

async function base_incrementVisitCount() {
  return Number(await redis('INCR', CLE_COMPTEUR));
}

async function base_getVisitCount() {
  return Number((await redis('GET', CLE_COMPTEUR)) || 0);
}

// ===========================================================================
// MODE 2 — Fichier temporaire /tmp (secours, comme l'ancienne version)
// ===========================================================================

const TMP_FILE = '/tmp/access.json';
const CERT_DIR = '/tmp/certificats';
const COUNTER_FILE = '/tmp/visit-counter.json';

function ensureTmpFile() {
  if (!fs.existsSync(TMP_FILE)) {
    const seed = fs.existsSync(SEED_FILE) ? fs.readFileSync(SEED_FILE, 'utf8') : '{}';
    fs.writeFileSync(TMP_FILE, seed);
  }
}

function readAll() {
  ensureTmpFile();
  try {
    return JSON.parse(fs.readFileSync(TMP_FILE, 'utf8') || '{}');
  } catch (err) {
    console.error('access.json corrompu, réinitialisation :', err);
    return {};
  }
}

function writeAll(data) {
  ensureTmpFile();
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2));
}

function cleFichier(all, email) {
  const cible = normaliser(email);
  return Object.keys(all).find((k) => normaliser(k) === cible) || cible;
}

async function fichier_getAccess(email) {
  const all = readAll();
  return all[cleFichier(all, email)] || defaultAccessRecord();
}

async function fichier_setAccess(email, formationKey, value = true) {
  const all = readAll();
  const cle = cleFichier(all, email);
  if (!all[cle]) all[cle] = defaultAccessRecord();
  all[cle][formationKey] = value;
  writeAll(all);
  return all[cle];
}

async function fichier_saveExamResult(email, formationKey, score, passed, nom) {
  const all = readAll();
  const cle = cleFichier(all, email);
  if (!all[cle]) all[cle] = defaultAccessRecord();
  if (!all[cle].examens) all[cle].examens = {};
  const nouveau = fusionnerResultat(all[cle].examens[formationKey], score, passed, nom);
  all[cle].examens[formationKey] = nouveau;
  writeAll(all);
  return nouveau;
}

async function fichier_getExamResult(email, formationKey) {
  const all = readAll();
  const fiche = all[cleFichier(all, email)];
  if (!fiche || !fiche.examens) return null;
  return presenterResultat(fiche.examens[formationKey]);
}

function nomFichierCertificat(email, formationKey) {
  const safeEmail = normaliser(email).replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(CERT_DIR, `${safeEmail}__${formationKey}.pdf`);
}

async function fichier_incrementVisitCount() {
  if (!fs.existsSync(COUNTER_FILE)) fs.writeFileSync(COUNTER_FILE, JSON.stringify({ count: 0 }));
  const data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8') || '{"count":0}');
  data.count += 1;
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(data));
  return data.count;
}

async function fichier_getVisitCount() {
  if (!fs.existsSync(COUNTER_FILE)) return 0;
  return JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8') || '{"count":0}').count;
}

// ===========================================================================
// Fonctions publiques — mêmes noms et mêmes paramètres qu'avant
// ===========================================================================

async function getAccess(email) {
  return MODE_BASE ? base_getAccess(email) : fichier_getAccess(email);
}

async function setAccess(email, formationKey, value = true) {
  return MODE_BASE ? base_setAccess(email, formationKey, value) : fichier_setAccess(email, formationKey, value);
}

async function saveExamResult(email, formationKey, score, passed, nom) {
  return MODE_BASE
    ? base_saveExamResult(email, formationKey, score, passed, nom)
    : fichier_saveExamResult(email, formationKey, score, passed, nom);
}

async function getExamResult(email, formationKey) {
  return MODE_BASE ? base_getExamResult(email, formationKey) : fichier_getExamResult(email, formationKey);
}

/**
 * En mode base de données, les PDF ne sont pas conservés : server.js les
 * reconstruit à partir du résultat d'examen, qui lui est permanent.
 */
async function saveCertificate(email, formationKey, pdfBuffer) {
  if (MODE_BASE) return null;
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
  const filepath = nomFichierCertificat(email, formationKey);
  fs.writeFileSync(filepath, pdfBuffer);
  return filepath;
}

function getCertificatePath(email, formationKey) {
  if (MODE_BASE) return null;
  const filepath = nomFichierCertificat(email, formationKey);
  return fs.existsSync(filepath) ? filepath : null;
}

async function incrementVisitCount() {
  return MODE_BASE ? base_incrementVisitCount() : fichier_incrementVisitCount();
}

async function getVisitCount() {
  return MODE_BASE ? base_getVisitCount() : fichier_getVisitCount();
}

/** Indique quel mode est actif : 'base' ou 'secours'. */
function modeStockage() {
  return MODE_BASE ? 'base' : 'secours';
}

module.exports = {
  getAccess,
  setAccess,
  saveExamResult,
  getExamResult,
  saveCertificate,
  getCertificatePath,
  defaultAccessRecord,
  incrementVisitCount,
  getVisitCount,
  modeStockage,
};
