/**
 * lib/store.js
 * ---------------------------------------------------------------------------
 * Stockage des accès (qui a payé quoi) et des certificats générés.
 *
 * ⚠️ LIMITE IMPORTANTE : Vercel exécute ce code dans des fonctions serverless.
 * Le système de fichiers n'est PAS persistant : seul /tmp est inscriptible,
 * et son contenu peut disparaître à tout moment (cold start, redéploiement).
 * Ce module fonctionne pour développer et tester. Pour la production réelle,
 * remplace-le par une vraie base de données (Vercel Postgres, Vercel KV...).
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const SEED_FILE = path.join(__dirname, '..', 'access.json');
const TMP_FILE = '/tmp/access.json';

const CERT_DIR = '/tmp/certificats';
const COUNTER_FILE = '/tmp/visit-counter.json';

function ensureTmpFile() {
  if (!fs.existsSync(TMP_FILE)) {
    const seed = fs.existsSync(SEED_FILE) ? fs.readFileSync(SEED_FILE, 'utf8') : '{}';
    fs.writeFileSync(TMP_FILE, seed);
  }
}

function ensureCertDir() {
  if (!fs.existsSync(CERT_DIR)) {
    fs.mkdirSync(CERT_DIR, { recursive: true });
  }
}

function ensureCounterFile() {
  if (!fs.existsSync(COUNTER_FILE)) {
    fs.writeFileSync(COUNTER_FILE, JSON.stringify({ count: 0 }));
  }
}

async function incrementVisitCount() {
  ensureCounterFile();
  const data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8') || '{"count":0}');
  data.count += 1;
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(data));
  return data.count;
}

async function getVisitCount() {
  ensureCounterFile();
  const data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8') || '{"count":0}');
  return data.count;
}

async function readAll() {
  ensureTmpFile();
  const raw = fs.readFileSync(TMP_FILE, 'utf8');
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('access.json corrompu, réinitialisation :', err);
    return {};
  }
}

async function writeAll(data) {
  ensureTmpFile();
  fs.writeFileSync(TMP_FILE, JSON.stringify(data, null, 2));
}

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

async function getAccess(email) {
  const all = await readAll();
  return all[email] || defaultAccessRecord();
}

async function setAccess(email, formationKey, value = true) {
  const all = await readAll();
  if (!all[email]) all[email] = defaultAccessRecord();
  all[email][formationKey] = value;
  await writeAll(all);
  return all[email];
}

async function saveExamResult(email, formationKey, score, passed) {
  const all = await readAll();
  if (!all[email]) all[email] = defaultAccessRecord();
  if (!all[email].examens) all[email].examens = {};
  all[email].examens[formationKey] = {
    score,
    passed,
    date: new Date().toISOString(),
  };
  await writeAll(all);
}

async function saveCertificate(email, formationKey, pdfBuffer) {
  ensureCertDir();
  const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const filename = `${safeEmail}__${formationKey}.pdf`;
  const filepath = path.join(CERT_DIR, filename);
  fs.writeFileSync(filepath, pdfBuffer);
  return filepath;
}

function getCertificatePath(email, formationKey) {
  ensureCertDir();
  const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const filename = `${safeEmail}__${formationKey}.pdf`;
  const filepath = path.join(CERT_DIR, filename);
  return fs.existsSync(filepath) ? filepath : null;
}

module.exports = {
  getAccess,
  setAccess,
  saveExamResult,
  saveCertificate,
  getCertificatePath,
  defaultAccessRecord,
  incrementVisitCount,
  getVisitCount,
};
