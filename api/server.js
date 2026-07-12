/**
 * api/server.js
 * ---------------------------------------------------------------------------
 * Backend principal Artisttattoo KGB — déployé comme fonction serverless
 * Vercel (voir vercel.json : toutes les routes sauf /webhook arrivent ici).
 *
 * Routes :
 *   POST /create-checkout-session   → crée une session Stripe Checkout
 *   POST /verify-access             → vérifie si un email a accès à un produit
 *   POST /validate-exam             → valide un examen (≥80%) et génère un certificat
 *   GET  /certificat/:email         → télécharge un certificat déjà généré
 *   GET  /health                    → healthcheck
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const PDFDocument = require('pdfkit');

const store = require('../lib/store');
const { PRODUCTS } = require('../lib/products');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();

const ALLOWED_ORIGINS = [
  process.env.ALLOWED_ORIGIN || 'https://formationtattoo.ca',
  'https://www.formationtattoo.ca',
  'http://localhost:3000',
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origine non autorisée par CORS'));
      }
    },
  })
);

app.use(bodyParser.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/visit-count', async (req, res) => {
  try {
    const count = await store.incrementVisitCount();
    return res.json({ count });
  } catch (err) {
    console.error('Erreur /visit-count :', err);
    return res.status(500).json({ error: 'Impossible de mettre à jour le compteur.' });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { formation, email } = req.body || {};

    if (!formation || typeof formation !== 'string') {
      return res.status(400).json({ error: 'Le champ "formation" est requis.' });
    }

    const product = PRODUCTS[formation];
    if (!product) {
      return res.status(400).json({ error: `Formation inconnue : "${formation}".` });
    }
    if (!product.priceId) {
      return res.status(500).json({
        error: `Aucun Price ID configuré pour "${formation}". Vérifie les variables d'environnement Vercel.`,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: product.mode,
      payment_method_types: ['card'],
      line_items: [{ price: product.priceId, quantity: 1 }],
      customer_email: email || undefined,
      success_url: `https://formationtattoo.ca/success?formation=${encodeURIComponent(
        formation
      )}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://formationtattoo.ca/payment-failed`,
      metadata: { formation },
    });

    return res.json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('Erreur /create-checkout-session :', err);
    return res.status(500).json({ error: 'Impossible de créer la session de paiement.' });
  }
});

app.post('/verify-access', async (req, res) => {
  try {
    const { email, formation } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Le champ "email" est requis.' });
    }

    const access = await store.getAccess(email);

    if (formation) {
      return res.json({ access: Boolean(access[formation]) });
    }
    return res.json({ access });
  } catch (err) {
    console.error('Erreur /verify-access :', err);
    return res.status(500).json({ error: 'Erreur de vérification des accès.' });
  }
});

const PASS_THRESHOLD = 80;

app.post('/validate-exam', async (req, res) => {
  try {
    const { email, formation, score, nom } = req.body || {};

    if (!email || !formation || typeof score !== 'number') {
      return res.status(400).json({ error: 'Champs requis : email, formation, score (nombre).' });
    }
    if (!PRODUCTS[formation]) {
      return res.status(400).json({ error: `Formation inconnue : "${formation}".` });
    }

    const access = await store.getAccess(email);
    if (!access[formation]) {
      return res.status(403).json({ error: "Aucun accès payé trouvé pour cette formation." });
    }

    const passed = score >= PASS_THRESHOLD;
    await store.saveExamResult(email, formation, score, passed);

    if (!passed) {
      return res.json({
        success: false,
        passed: false,
        message: `Score insuffisant (${score}%). Il faut au moins ${PASS_THRESHOLD}% pour débloquer le certificat.`,
      });
    }

    const pdfBuffer = await generateCertificatePdf({ email, formation, nom });
    await store.saveCertificate(email, formation, pdfBuffer);

    return res.json({
      success: true,
      passed: true,
      url: `/certificat/${encodeURIComponent(email)}?formation=${encodeURIComponent(formation)}`,
    });
  } catch (err) {
    console.error('Erreur /validate-exam :', err);
    return res.status(500).json({ error: 'Erreur de validation de l\'examen.' });
  }
});

app.get('/certificat/:email', (req, res) => {
  try {
    const { email } = req.params;
    const { formation } = req.query;

    if (!formation) {
      return res.status(400).json({ error: 'Le paramètre "formation" est requis (?formation=debutant).' });
    }

    const filepath = store.getCertificatePath(email, formation);
    if (!filepath) {
      return res.status(404).json({
        error: "Certificat introuvable. Il n'a peut-être pas encore été généré, ou il a été perdu suite à un redémarrage du serveur.",
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificat-${formation}.pdf"`);
    require('fs').createReadStream(filepath).pipe(res);
  } catch (err) {
    console.error('Erreur /certificat/:email :', err);
    res.status(500).json({ error: 'Erreur lors de la récupération du certificat.' });
  }
});

function generateCertificatePdf({ email, formation, nom }) {
  return new Promise((resolve, reject) => {
    const product = PRODUCTS[formation];
    const displayName = (nom && nom.trim()) ? nom.trim() : email;

    const GOLD = '#D4AF37';
    const GOLD_DIM = '#8a7328';
    const INK = '#0A0A0A';
    const TITLE = '#E0E0E0';
    const TEXT = '#C8C8C8';

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks = [];
    const W = doc.page.width;
    const H = doc.page.height;

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, W, H).fill(INK);

    doc.lineWidth(2.5).strokeColor(GOLD).rect(28, 28, W - 56, H - 56).stroke();
    doc.lineWidth(0.75).strokeColor(GOLD_DIM).rect(40, 40, W - 80, H - 80).stroke();

    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12)
      .text('A R T I S T T A T T O O   K G B', 0, 78, { align: 'center', width: W });
    doc.fillColor(TEXT).font('Helvetica').fontSize(9)
      .text('É C O L E   D E   T A T O U A G E   P R O F E S S I O N N E L L E', 0, 96, { align: 'center', width: W });

    doc.moveTo(W / 2 - 60, 122).lineTo(W / 2 + 60, 122).lineWidth(1).strokeColor(GOLD).stroke();

    doc.fillColor(TITLE).font('Helvetica-Bold').fontSize(34)
      .text('CERTIFICAT DE COMPLÉTION', 0, 148, { align: 'center', width: W });

    doc.fillColor(TEXT).font('Helvetica-Oblique').fontSize(13)
      .text('Ce certificat est décerné à', 0, 205, { align: 'center', width: W });

    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(30)
      .text(displayName, 60, 232, { align: 'center', width: W - 120 });

    doc.moveTo(W / 2 - 140, 278).lineTo(W / 2 + 140, 278).lineWidth(0.75).strokeColor(GOLD_DIM).stroke();

    doc.fillColor(TEXT).font('Helvetica').fontSize(13)
      .text('pour avoir complété avec succès la', 0, 296, { align: 'center', width: W });

    doc.fillColor(TITLE).font('Helvetica-Bold').fontSize(19)
      .text(product ? product.label : formation, 0, 318, { align: 'center', width: W });

    const dateStr = new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(10)
      .text(`Délivré le ${dateStr}`, 0, H - 110, { align: 'center', width: W });

    doc.fillColor(TEXT).font('Helvetica').fontSize(10)
      .text('Artisttattoo KGB — École de Tatouage Professionnelle · Kitigan Zibi, Québec', 0, H - 92, { align: 'center', width: W });

    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(8)
      .text('formationtattoo.ca', W - 200, H - 60, { width: 160, align: 'right' });

    doc.end();
  });
}

module.exports = app;
