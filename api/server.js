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
    const { email, formation, score } = req.body || {};

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

    const pdfBuffer = await generateCertificatePdf({ email, formation, score });
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

function generateCertificatePdf({ email, formation, score }) {
  return new Promise((resolve, reject) => {
    const product = PRODUCTS[formation];
    const doc = new PDFDocument({ size: 'A4', margin: 60 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(10).fillColor('#9c1c1c').text('ARTISTTATTOO KGB', { align: 'center' }).moveDown(2);
    doc.fontSize(28).fillColor('#0e0e0e').text('CERTIFICAT DE COMPLÉTION', { align: 'center' }).moveDown(1.5);
    doc.fontSize(14).fillColor('#3a3a3a').text('Ce certificat atteste que', { align: 'center' }).moveDown(0.5);
    doc.fontSize(20).fillColor('#0e0e0e').text(email, { align: 'center' }).moveDown(0.5);
    doc.fontSize(14).fillColor('#3a3a3a').text(`a complété avec succès la formation`, { align: 'center' }).moveDown(0.3);
    doc.fontSize(18).fillColor('#9c1c1c').text(product ? product.label : formation, { align: 'center' }).moveDown(0.5);
    doc.fontSize(13).fillColor('#3a3a3a').text(`avec un score de ${score}%`, { align: 'center' }).moveDown(2);
    doc.fontSize(11).fillColor('#8f8a7c').text(`Délivré le ${new Date().toLocaleDateString('fr-CA')}`, { align: 'center' });

    doc.end();
  });
}

module.exports = app;
