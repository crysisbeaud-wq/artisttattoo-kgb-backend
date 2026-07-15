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

    // Notification push via ntfy (on attend l'envoi avant de répondre — requis sur Vercel)
    try {
      await fetch('https://ntfy.sh/kgb-visites-3t7m9q', {
        method: 'POST',
        headers: { 'Title': 'Visite sur formationtattoo.ca' },
        body: `Visiteur #${count} sur le site`,
      });
    } catch (e) {
      console.error('Erreur ntfy :', e);
    }

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

    // ---- En-tête (fixe, proche du haut) ----
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12)
      .text('A R T I S T T A T T O O   K G B', 0, 62, { align: 'center', width: W });
    doc.fillColor(TEXT).font('Helvetica').fontSize(9)
      .text('É C O L E   D E   T A T O U A G E   P R O F E S S I O N N E L L E', 0, 80, { align: 'center', width: W });
    doc.moveTo(W / 2 - 60, 104).lineTo(W / 2 + 60, 104).lineWidth(1).strokeColor(GOLD).stroke();

    // ---- Bloc central : hauteur calculée dynamiquement, puis centré verticalement ----
    const areaTop = 120;
    const areaBottom = H - 175;
    const availableHeight = areaBottom - areaTop;

    const items = [
      { text: 'CERTIFICAT DE COMPLÉTION', font: 'Helvetica-Bold', size: 34, color: TITLE, gapAfter: 22 },
      { text: 'Ce certificat est décerné à', font: 'Helvetica-Oblique', size: 13, color: TEXT, gapAfter: 12 },
      { text: displayName, font: 'Helvetica-Bold', size: 30, color: GOLD, gapAfter: 18 },
      { separatorOnly: true, gapAfter: 18 },
      { text: 'pour avoir complété avec succès la', font: 'Helvetica', size: 13, color: TEXT, gapAfter: 10 },
      { text: product ? product.label : formation, font: 'Helvetica-Bold', size: 19, color: TITLE, gapAfter: 0 },
    ];

    let totalHeight = 0;
    items.forEach((item) => {
      if (item.separatorOnly) {
        item._h = 1;
      } else {
        doc.font(item.font).fontSize(item.size);
        item._h = doc.heightOfString(item.text, { width: W - 120, align: 'center' });
      }
      totalHeight += item._h + item.gapAfter;
    });
    totalHeight -= items[items.length - 1].gapAfter;

    let y = areaTop + Math.max(0, (availableHeight - totalHeight) / 2);

    items.forEach((item) => {
      if (item.separatorOnly) {
        doc.moveTo(W / 2 - 140, y + item._h / 2).lineTo(W / 2 + 140, y + item._h / 2)
          .lineWidth(0.75).strokeColor(GOLD_DIM).stroke();
      } else {
        doc.fillColor(item.color).font(item.font).fontSize(item.size)
          .text(item.text, 60, y, { align: 'center', width: W - 120 });
      }
      y += item._h + item.gapAfter;
    });

    // ---- Pied de page (fixe, proche du bas) ----
    const dateStr = new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(10)
      .text(`Délivré le ${dateStr}`, 0, H - 155, { align: 'center', width: W });
    doc.fillColor(TEXT).font('Helvetica').fontSize(10)
      .text('Artisttattoo KGB — École de Tatouage Professionnelle · Kitigan Zibi, Québec', 0, H - 137, { align: 'center', width: W });
    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(8)
      .text('formationtattoo.ca', 0, H - 48, { align: 'center', width: W });

    // ---- Signature manuscrite, bas droite ----
    const sigWidth = 200;
    const sigRight = W - 60;
    const sigLineY = H - 92;

    doc.fillColor(GOLD).font('Times-Italic').fontSize(17)
      .text('Karl Gervais Beaudoin', sigRight - sigWidth, sigLineY - 24, { width: sigWidth, align: 'center' });

    doc.moveTo(sigRight - sigWidth, sigLineY).lineTo(sigRight, sigLineY)
      .lineWidth(0.75).strokeColor(GOLD_DIM).stroke();

    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(8)
      .text('Fondateur — Artisttattoo KGB', sigRight - sigWidth, sigLineY + 6, { width: sigWidth, align: 'center' });

    doc.end();
  });
}

module.exports = app;
