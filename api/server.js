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

// ---------------------------------------------------------------------------
// Sécurité CORS : seul le site Hostinger (et localhost en dev) peut appeler
// ce backend. Ajuste ALLOWED_ORIGIN dans les variables d'environnement
// Vercel si ton domaine change.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// POST /visit-count
// Incrémente et renvoie le compteur de visites du site (footer Hostinger).
// Même limite de persistance que le reste de lib/store.js (voir en-tête du fichier).
// ---------------------------------------------------------------------------
app.post('/visit-count', async (req, res) => {
  try {
    const count = await store.incrementVisitCount();
    return res.json({ count });
  } catch (err) {
    console.error('Erreur /visit-count :', err);
    return res.status(500).json({ error: 'Impossible de mettre à jour le compteur.' });
  }
});

// ---------------------------------------------------------------------------
// POST /create-checkout-session
// Body attendu : { formation: "debutant", email: "client@example.com" (optionnel) }
// ---------------------------------------------------------------------------
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
      mode: product.mode, // "payment" ou "subscription"
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

// ---------------------------------------------------------------------------
// POST /verify-access
// Body attendu : { email: "client@example.com", formation: "debutant" (optionnel) }
// - Si "formation" est fourni  → { access: true|false }
// - Sinon                      → renvoie l'ensemble des accès de cet email
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// POST /validate-exam
// Body attendu : { email: "...", formation: "debutant", score: 87 }
// (NOTE : "formation" a été ajouté à la spec d'origine — indispensable pour
//  savoir quel examen/certificat générer. Sans lui, impossible de distinguer
//  un examen "débutant" d'un examen "expert" pour le même email.)
// ---------------------------------------------------------------------------
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

    // Le client doit avoir payé la formation avant de pouvoir valider son examen
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

    // Génération du certificat PDF (design "10 Masters", nom du client si fourni)
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

// ---------------------------------------------------------------------------
// GET /certificat/:email?formation=debutant
// ---------------------------------------------------------------------------
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
        error:
          "Certificat introuvable. Il n'a peut-être pas encore été généré, ou il a été perdu suite à un redémarrage du serveur (voir lib/store.js).",
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

// ---------------------------------------------------------------------------
// Génération du certificat PDF (mise en page simple, texte)
// ---------------------------------------------------------------------------
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
    const W = doc.page.width;   // ≈ 842
    const H = doc.page.height;  // ≈ 595

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Fond noir plein
    doc.rect(0, 0, W, H).fill(INK);

    // Cadre double : bordure or épaisse, puis fine bordure intérieure
    doc.lineWidth(2.5).strokeColor(GOLD).rect(28, 28, W - 56, H - 56).stroke();
    doc.lineWidth(0.75).strokeColor(GOLD_DIM).rect(40, 40, W - 80, H - 80).stroke();

    // ------------------------------------------------------------------
    // Bloc central — positions calculées pour un équilibre vertical :
    // le contenu occupe la zone 95 → 420, centré dans la page de 595.
    // ------------------------------------------------------------------

    // En-tête
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12)
      .text('A R T I S T T A T T O O   K G B', 0, 95, { align: 'center', width: W });
    doc.fillColor(TEXT).font('Helvetica').fontSize(9)
      .text('É C O L E   D E   T A T O U A G E   P R O F E S S I O N N E L L E', 0, 114, { align: 'center', width: W });

    // Ligne décorative
    doc.moveTo(W / 2 - 60, 140).lineTo(W / 2 + 60, 140).lineWidth(1).strokeColor(GOLD).stroke();

    // Titre principal
    doc.fillColor(TITLE).font('Helvetica-Bold').fontSize(34)
      .text('CERTIFICAT DE COMPLÉTION', 0, 168, { align: 'center', width: W });

    // Sous-texte
    doc.fillColor(TEXT).font('Helvetica-Oblique').fontSize(13)
      .text('Ce certificat est décerné à', 0, 232, { align: 'center', width: W });

    // Nom du récipiendaire — élément central, grande taille
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(30)
      .text(displayName, 60, 262, { align: 'center', width: W - 120 });

    // Ligne sous le nom
    doc.moveTo(W / 2 - 140, 308).lineTo(W / 2 + 140, 308).lineWidth(0.75).strokeColor(GOLD_DIM).stroke();

    // Texte de réussite
    doc.fillColor(TEXT).font('Helvetica').fontSize(13)
      .text('pour avoir complété avec succès la', 0, 330, { align: 'center', width: W });

    doc.fillColor(TITLE).font('Helvetica-Bold').fontSize(19)
      .text(product ? product.label : formation, 0, 356, { align: 'center', width: W });

    // Date + lieu (bloc centré, remonté pour équilibrer avec la signature)
    const dateStr = new Date().toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(10)
      .text(`Délivré le ${dateStr}`, 0, 412, { align: 'center', width: W });

    doc.fillColor(TEXT).font('Helvetica').fontSize(10)
      .text('Artisttattoo KGB — École de Tatouage Professionnelle · Kitigan Zibi, Québec', 0, 430, { align: 'center', width: W });

    // ------------------------------------------------------------------
    // Signature — bas droit, style manuscrit (italique élégante)
    // ------------------------------------------------------------------
    const sigCenterX = W - 210;   // centre du bloc signature
    const sigWidth = 260;

    doc.fillColor(GOLD).font('Times-Italic').fontSize(24)
      .text('Karl Gervais Beaudoin', sigCenterX - sigWidth / 2, H - 128, { width: sigWidth, align: 'center' });

    // Ligne de signature sous le nom
    doc.moveTo(sigCenterX - 100, H - 96).lineTo(sigCenterX + 100, H - 96)
      .lineWidth(0.75).strokeColor(GOLD_DIM).stroke();

    doc.fillColor(TEXT).font('Helvetica').fontSize(8)
      .text('Fondateur — Artisttattoo KGB', sigCenterX - sigWidth / 2, H - 88, { width: sigWidth, align: 'center' });

    // Tampon décoratif discret (coin inférieur gauche pour équilibrer)
    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(8)
      .text('formationtattoo.ca', 60, H - 66, { width: 160, align: 'left' });

    doc.end();
  });
}


module.exports = app;

    
