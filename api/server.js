/**
 * api/server.js
 * ---------------------------------------------------------------------------
 * Backend principal Artisttattoo KGB — déployé comme fonction serverless
 * Vercel (voir vercel.json : toutes les routes sauf /webhook arrivent ici).
 *
 * Routes :
 *   POST /create-checkout-session   → crée une session Stripe Checkout
 *   POST /verify-access             → vérifie si un email a accès à un produit
 *   POST /formation/contenu         → envoie les chapitres + l'examen (sans réponses) aux acheteurs
 *   POST /validate-exam             → corrige l'examen ICI (≥80%) et génère un certificat
 *   GET  /certificat/:email         → télécharge un certificat (le regénère s'il a été perdu)
 *   POST /admin/certificat          → génère un certificat à la main (réservé à l'admin)
 *   POST /admin/acces               → consulter / accorder / retirer un accès (réservé à l'admin)
 *   GET  /health                    → healthcheck
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');

const store = require('../lib/store');
const { PRODUCTS } = require('../lib/products');

// Logo doré embarqué dans le code (voir lib/logo-kgb.js). S'il manque,
// le certificat se rabat sur un sceau dessiné : il sort quand même.
let LOGO_KGB = null;
try {
  LOGO_KGB = require('../lib/logo-kgb');
} catch (e) {
  console.error('lib/logo-kgb.js introuvable, sceau de repli utilisé :', e.message);
}

// Contenu payant des formations (chapitres + examens avec réponses).
// Il vit seulement ici, sur le serveur : voir lib/contenu-debutant.js, etc.
const CONTENUS = {};
['debutant', 'intermediaire', 'expert'].forEach((niveau) => {
  try {
    CONTENUS[niveau] = require(`../lib/contenu-${niveau}`);
  } catch (e) {
    console.error(`lib/contenu-${niveau}.js introuvable :`, e.message);
  }
});

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

    // --- Localisation approximative du visiteur (ville/région) ---
    let lieu = '';
    try {
      // Vercel fournit ces en-têtes automatiquement
      const villeVercel = req.headers['x-vercel-ip-city'];
      const regionVercel = req.headers['x-vercel-ip-country-region'];
      const paysVercel = req.headers['x-vercel-ip-country'];

      if (villeVercel) {
        lieu = [decodeURIComponent(villeVercel), regionVercel, paysVercel]
          .filter(Boolean)
          .join(', ');
      } else {
        // Repli : interroger un service de géolocalisation IP gratuit
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        if (ip) {
          const geo = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country`);
          const data = await geo.json();
          if (data && data.status === 'success') {
            lieu = [data.city, data.regionName, data.country].filter(Boolean).join(', ');
          }
        }
      }
    } catch (e) {
      console.error('Erreur géolocalisation :', e);
    }

    const message = lieu
      ? `Visiteur #${count} — ${lieu}`
      : `Visiteur #${count} sur le site`;

    // Notification push via ntfy (on attend l'envoi avant de répondre — requis sur Vercel)
    try {
      await fetch('https://ntfy.sh/kgb-visites-3t7m9q', {
        method: 'POST',
        headers: { 'Title': 'Visite sur formationtattoo.ca' },
        body: message,
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

function aAccesFormation(access, formation) {
  return Boolean(access && (access[formation] || access.pack_complet));
}

/**
 * Envoie le contenu payant d'une formation, seulement si l'email a acheté.
 * Les questions d'examen partent SANS les bonnes réponses.
 */
app.post('/formation/contenu', async (req, res) => {
  try {
    const { email, formation } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Entre une adresse courriel valide.' });
    }
    const contenu = CONTENUS[formation];
    if (!contenu) {
      return res.status(400).json({ error: `Formation inconnue : "${formation}".` });
    }

    const access = await store.getAccess(email);
    if (!aAccesFormation(access, formation)) {
      return res.status(403).json({ error: "Aucun accès trouvé pour ce courriel pour cette formation." });
    }

    const { examen } = contenu;
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      formation,
      chapitresHtml: contenu.chapitresHtml,
      examen: {
        titre: examen.titre,
        noteDePassage: examen.noteDePassage || PASS_THRESHOLD,
        questions: examen.questions.map(({ correct, ...q }) => q),
        questionsReflexion: examen.questionsReflexion || [],
      },
    });
  } catch (err) {
    console.error('Erreur /formation/contenu :', err);
    return res.status(500).json({ error: 'Impossible de charger la formation pour le moment.' });
  }
});

/** Corrige les réponses envoyées par l'élève avec le corrigé du serveur. */
function corrigeExamen(examen, reponses) {
  let bonnes = 0;
  const manquantes = [];
  const corrections = {};

  examen.questions.forEach((q) => {
    corrections[q.num] = q.correct;
    const brut = reponses[q.num] !== undefined ? reponses[q.num] : reponses[String(q.num)];
    let valeur = null;
    if (q.type === 'vf') {
      if (brut === true || brut === 'true') valeur = true;
      else if (brut === false || brut === 'false') valeur = false;
    } else if (brut !== null && brut !== '' && Number.isInteger(Number(brut))) {
      valeur = Number(brut);
    }
    if (valeur === null) manquantes.push(q.num);
    else if (valeur === q.correct) bonnes += 1;
  });

  const total = examen.questions.length;
  return { bonnes, total, manquantes, corrections, score: Math.round((bonnes / total) * 100) };
}

app.post('/validate-exam', async (req, res) => {
  try {
    const { email, formation, reponses, nom } = req.body || {};

    // Ancienne page (qui envoyait elle-même sa note) : on ne la croit plus sur parole
    if (!reponses || typeof reponses !== 'object' || Array.isArray(reponses)) {
      return res.status(400).json({
        error: "Cette page n'est plus à jour. Recharge-la, puis soumets ton examen à nouveau.",
      });
    }
    if (!email || !formation) {
      return res.status(400).json({ error: 'Champs requis : email, formation, reponses.' });
    }
    const contenu = CONTENUS[formation];
    if (!contenu || !PRODUCTS[formation]) {
      return res.status(400).json({ error: `Formation inconnue : "${formation}".` });
    }

    const access = await store.getAccess(email);
    if (!aAccesFormation(access, formation)) {
      return res.status(403).json({ error: "Aucun accès payé trouvé pour cette formation." });
    }

    const resultat = corrigeExamen(contenu.examen, reponses);
    if (resultat.manquantes.length) {
      return res.status(400).json({
        error: `Il manque des réponses (question${resultat.manquantes.length > 1 ? 's' : ''} ${resultat.manquantes.join(', ')}).`,
        manquantes: resultat.manquantes,
      });
    }

    const seuil = contenu.examen.noteDePassage || PASS_THRESHOLD;
    const { score, bonnes, total, corrections } = resultat;
    const passed = score >= seuil;
    await store.saveExamResult(email, formation, score, passed, nom);

    const reponse = { passed, score, bonnes, total, noteDePassage: seuil, corrections };

    if (!passed) {
      return res.json({
        ...reponse,
        success: false,
        message: `Score insuffisant (${score}%). Il faut au moins ${seuil}% pour débloquer le certificat.`,
      });
    }

    const pdfBuffer = await generateCertificatePdf({ email, formation, nom, score });
    await store.saveCertificate(email, formation, pdfBuffer);

    return res.json({
      ...reponse,
      success: true,
      url: `/certificat/${encodeURIComponent(email)}?formation=${encodeURIComponent(formation)}`,
    });
  } catch (err) {
    console.error('Erreur /validate-exam :', err);
    return res.status(500).json({ error: 'Erreur de validation de l\'examen.' });
  }
});

/**
 * Télécharge le certificat d'un client, autant de fois qu'il le veut.
 *
 * Vercel vide son dossier temporaire régulièrement : le PDF enregistré
 * finit par disparaître. Plutôt que de répondre « certificat introuvable »,
 * on le reconstruit à la volée à partir de l'accès payé. Un client ne doit
 * jamais perdre son certificat parce que le serveur a redémarré.
 */
app.get('/certificat/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const { formation, nom } = req.query;

    if (!formation) {
      return res.status(400).json({ error: 'Le paramètre "formation" est requis (?formation=debutant).' });
    }
    if (!PRODUCTS[formation]) {
      return res.status(400).json({ error: `Formation inconnue : "${formation}".` });
    }

    // 1) Le PDF est encore sur le disque : on le sert tel quel
    const filepath = store.getCertificatePath(email, formation);
    if (filepath) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="certificat-${formation}.pdf"`);
      return require('fs').createReadStream(filepath).pipe(res);
    }

    // 2) Le PDF a été perdu. On ne le refait QUE si l'examen a été réussi.
    //    Règle absolue : pas de certificat sans réussite confirmée.
    const access = await store.getAccess(email);
    const aAcces = access && (access[formation] || access.pack_complet);
    if (!aAcces) {
      return res.status(404).json({
        error: "Aucun achat trouvé pour cette adresse. Vérifie l'email utilisé lors du paiement, ou écris-nous à artisttattoo.kgb@gmail.com.",
      });
    }

    let resultat = null;
    if (typeof store.getExamResult === 'function') {
      try {
        resultat = await store.getExamResult(email, formation);
      } catch (e) {
        console.error('Lecture du résultat d\'examen impossible :', e);
      }
    }

    if (!resultat || resultat.passed !== true) {
      return res.status(403).json({
        error: resultat && typeof resultat.score === 'number'
          ? `Examen non réussi (${resultat.score} %). Il faut au moins ${PASS_THRESHOLD} % pour obtenir le certificat.`
          : "Aucune réussite d'examen enregistrée pour cette formation. Si tu as déjà réussi l'examen, écris-nous à artisttattoo.kgb@gmail.com et on te renvoie ton certificat.",
      });
    }

    const pdfBuffer = await generateCertificatePdf({
      email,
      formation,
      nom: nom || resultat.nom,
      score: resultat.score,
      date: resultat.date,
    });
    try {
      await store.saveCertificate(email, formation, pdfBuffer);
    } catch (e) {
      console.error('Réenregistrement du certificat impossible :', e);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificat-${formation}.pdf"`);
    return res.end(pdfBuffer);
  } catch (err) {
    console.error('Erreur /certificat/:email :', err);
    res.status(500).json({ error: 'Erreur lors de la récupération du certificat.' });
  }
});

/**
 * Génération manuelle d'un certificat, réservée à l'administrateur.
 *
 * Sert à deux choses :
 *   - décerner un certificat aux élèves formés en studio (Tattoo Pass),
 *     qui ne passent jamais l'examen en ligne ;
 *   - réimprimer n'importe quel certificat, même très ancien.
 *
 * Protégée par la variable d'environnement ADMIN_SECRET (à définir dans Vercel).
 * Rien n'est enregistré : le PDF est construit et envoyé directement.
 */
function secretsEgaux(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function slugNom(s) {
  const base = String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return base || 'certificat';
}

app.post('/admin/certificat', async (req, res) => {
  try {
    const secretAttendu = process.env.ADMIN_SECRET;
    if (!secretAttendu) {
      return res.status(503).json({
        error: "ADMIN_SECRET n'est pas configuré sur le serveur. Ajoute-le dans les variables d'environnement Vercel.",
      });
    }

    const { secret, nom, formation, email, score, confirme } = req.body || {};

    if (!secret || !secretsEgaux(secret, secretAttendu)) {
      return res.status(401).json({ error: 'Mot de passe administrateur invalide.' });
    }
    if (!nom || !String(nom).trim()) {
      return res.status(400).json({ error: 'Le champ "nom" est requis.' });
    }
    if (!formation || !PRODUCTS[formation]) {
      return res.status(400).json({ error: `Formation inconnue : "${formation}".` });
    }

    // Règle absolue : aucun certificat sans examen réussi. En manuel, c'est
    // le formateur qui l'atteste explicitement — pas une note inventée.
    if (confirme !== true) {
      return res.status(400).json({
        error: "Il faut confirmer que la personne a réussi l'examen avant de décerner un certificat.",
      });
    }

    // La note est facultative. Fournie, elle doit correspondre à une réussite.
    let note;
    if (score !== undefined && score !== null && String(score).trim() !== '') {
      note = Number(score);
      if (!isFinite(note) || note < PASS_THRESHOLD || note > 100) {
        return res.status(400).json({
          error: `Si tu inscris une note, elle doit être entre ${PASS_THRESHOLD} et 100. Laisse le champ vide si tu ne la connais pas.`,
        });
      }
    }

    const pdfBuffer = await generateCertificatePdf({
      email: email || '',
      formation,
      nom: String(nom).trim(),
      score: note,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="certificat-${formation}-${slugNom(nom)}.pdf"`
    );
    return res.end(pdfBuffer);
  } catch (err) {
    console.error('Erreur /admin/certificat :', err);
    return res.status(500).json({ error: 'Erreur lors de la génération du certificat.' });
  }
});

/**
 * Gestion manuelle des accès, réservée à l'administrateur.
 *
 *   action « consulter » : affiche les accès et les examens d'un courriel
 *   action « accorder »  : donne l'accès à une formation
 *   action « retirer »   : retire l'accès à une formation
 *
 * Sert à rétablir un client, à donner l'accès à un élève formé en studio,
 * à gérer un remboursement, ou à se donner l'accès pour tester.
 * Protégée par ADMIN_SECRET, comme la génération de certificats.
 */
const FORMATIONS_DU_PACK = ['debutant', 'intermediaire', 'expert'];
const FORMATIONS_AVEC_EXAMEN = ['debutant', 'intermediaire', 'expert'];

async function resumeAcces(email) {
  const acces = await store.getAccess(email);
  const examens = {};
  for (const f of FORMATIONS_AVEC_EXAMEN) {
    examens[f] = await store.getExamResult(email, f);
  }
  return { email: String(email).trim().toLowerCase(), acces, examens };
}

app.post('/admin/acces', async (req, res) => {
  try {
    const secretAttendu = process.env.ADMIN_SECRET;
    if (!secretAttendu) {
      return res.status(503).json({
        error: "ADMIN_SECRET n'est pas configuré sur le serveur. Ajoute-le dans les variables d'environnement Vercel.",
      });
    }

    const { secret, email, formation, action } = req.body || {};

    if (!secret || !secretsEgaux(secret, secretAttendu)) {
      return res.status(401).json({ error: 'Mot de passe administrateur invalide.' });
    }

    const courriel = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(courriel)) {
      return res.status(400).json({ error: 'Courriel invalide.' });
    }

    if (action === 'consulter') {
      return res.json(await resumeAcces(courriel));
    }

    if (action !== 'accorder' && action !== 'retirer') {
      return res.status(400).json({ error: `Action inconnue : "${action}".` });
    }
    if (!formation || !PRODUCTS[formation]) {
      return res.status(400).json({ error: `Formation inconnue : "${formation}".` });
    }

    const valeur = action === 'accorder';
    await store.setAccess(courriel, formation, valeur);

    // Même logique que le webhook Stripe : le pack débloque les trois formations
    if (formation === 'pack_complet' && valeur) {
      for (const f of FORMATIONS_DU_PACK) {
        await store.setAccess(courriel, f, true);
      }
    }

    console.log(`🔑 Admin : ${action} ${formation} → ${courriel}`);
    return res.json(await resumeAcces(courriel));
  } catch (err) {
    console.error('Erreur /admin/acces :', err);
    return res.status(500).json({ error: 'Erreur lors de la gestion des accès.' });
  }
});

/**
 * Numéro de certificat, stable dans le temps : le même élève et la même
 * formation redonnent toujours le même numéro, même si le PDF est refait.
 */
function numeroCertificat(identifiant, formation) {
  const prefixe = String(formation).replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'KGB';
  const empreinte = crypto
    .createHash('sha256')
    .update(String(identifiant || '').toLowerCase() + '|' + String(formation))
    .digest('hex')
    .slice(0, 6)
    .toUpperCase();
  return `KGB-${prefixe}-${empreinte}`;
}

/**
 * Certificat de réussite — A4 paysage, noir et or.
 * `score` et `date` sont facultatifs : sans score, la ligne de note est omise.
 */
function generateCertificatePdf({ email, formation, nom, score, date }) {
  return new Promise((resolve, reject) => {
    const product = PRODUCTS[formation];
    const displayName = (nom && String(nom).trim()) ? String(nom).trim() : email;

    const GOLD = '#D4AF37';
    const GOLD_DIM = '#8a7328';
    const INK = '#0A0A0A';
    const TITLE = '#E0E0E0';
    const TEXT = '#C8C8C8';
    const FAINT = '#5a5a5a';

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks = [];
    const W = doc.page.width;
    const H = doc.page.height;

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ---- Fond et double encadrement ----
    doc.rect(0, 0, W, H).fill(INK);
    doc.lineWidth(2.5).strokeColor(GOLD).rect(28, 28, W - 56, H - 56).stroke();
    doc.lineWidth(0.75).strokeColor(GOLD_DIM).rect(40, 40, W - 80, H - 80).stroke();

    // ---- Équerres dorées dans les quatre coins ----
    const ornementCoin = (x, y, sx, sy) => {
      const L = 26, D = 9, r = 3.2;
      doc.lineWidth(1.4).strokeColor(GOLD);
      doc.moveTo(x + sx * D, y).lineTo(x + sx * L, y).stroke();
      doc.moveTo(x, y + sy * D).lineTo(x, y + sy * L).stroke();
      const cx = x + sx * 5.5, cy = y + sy * 5.5;
      doc.moveTo(cx, cy - r).lineTo(cx + r, cy).lineTo(cx, cy + r).lineTo(cx - r, cy)
        .closePath().fill(GOLD);
    };
    ornementCoin(52, 52, 1, 1);
    ornementCoin(W - 52, 52, -1, 1);
    ornementCoin(52, H - 52, 1, -1);
    ornementCoin(W - 52, H - 52, -1, -1);

    // ---- En-tête ----
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(12)
      .text('ARTISTTATTOO KGB', 0, 62, { align: 'center', width: W, characterSpacing: 3 });
    doc.fillColor(TEXT).font('Helvetica').fontSize(8.5)
      .text('ÉCOLE DE TATOUAGE PROFESSIONNELLE', 0, 81, { align: 'center', width: W, characterSpacing: 2.4 });
    doc.moveTo(W / 2 - 60, 106).lineTo(W / 2 + 60, 106).lineWidth(1).strokeColor(GOLD).stroke();

    // ---- Bloc central, mesuré puis centré entre l'en-tête et la bande du bas ----
    const areaTop = 122;
    const areaBottom = 404;

    const items = [
      { text: 'CERTIFICAT DE RÉUSSITE', font: 'Helvetica-Bold', size: 33, color: TITLE, spacing: 2, gapAfter: 28 },
      { text: 'Ce certificat est décerné à', font: 'Helvetica-Oblique', size: 13, color: TEXT, gapAfter: 18 },
      { text: displayName, font: 'Times-Italic', size: 44, color: GOLD, gapAfter: 18 },
      { separatorOnly: true, gapAfter: 24 },
      { text: 'pour avoir complété avec succès la', font: 'Helvetica', size: 13, color: TEXT, gapAfter: 13 },
      { text: product ? product.label : formation, font: 'Helvetica-Bold', size: 18, color: TITLE, gapAfter: 15 },
    ];
    if (typeof score === 'number' && isFinite(score)) {
      items.push({
        text: `Examen final réussi avec une note de ${Math.round(score)} %`,
        font: 'Helvetica', size: 11, color: GOLD_DIM, gapAfter: 0,
      });
    }
    items[items.length - 1].gapAfter = 0;

    let totalHeight = 0;
    items.forEach((item) => {
      if (item.separatorOnly) {
        item._h = 1;
      } else {
        doc.font(item.font).fontSize(item.size);
        item._h = doc.heightOfString(item.text, {
          width: W - 120, align: 'center', characterSpacing: item.spacing || 0,
        });
      }
      totalHeight += item._h + item.gapAfter;
    });

    let y = areaTop + Math.max(0, (areaBottom - areaTop - totalHeight) / 2);

    items.forEach((item) => {
      if (item.separatorOnly) {
        doc.moveTo(W / 2 - 150, y).lineTo(W / 2 + 150, y)
          .lineWidth(0.75).strokeColor(GOLD_DIM).stroke();
      } else {
        doc.fillColor(item.color).font(item.font).fontSize(item.size)
          .text(item.text, 60, y, {
            align: 'center', width: W - 120, characterSpacing: item.spacing || 0,
          });
      }
      y += item._h + item.gapAfter;
    });

    // ---- Logo Artisttattoo KGB, bas gauche ----
    const LOGO_RATIO = 0.6987;           // hauteur / largeur du fichier
    const logoW = 176;
    const logoH = logoW * LOGO_RATIO;
    let logoPose = false;

    if (LOGO_KGB) {
      try {
        doc.image(LOGO_KGB, 72, 455 - logoH / 2, { width: logoW });
        logoPose = true;
      } catch (e) {
        console.error('Logo illisible, sceau de repli utilisé :', e.message);
      }
    }

    if (!logoPose) {
      // Repli : sceau dessiné, pour qu'un certificat sorte même sans le logo
      const scX = 118, scY = 455;
      doc.circle(scX, scY, 43).lineWidth(1.6).strokeColor(GOLD).stroke();
      doc.circle(scX, scY, 37).lineWidth(0.7).strokeColor(GOLD_DIM).stroke();
      for (let i = 0; i < 28; i++) {
        const a = (i * 2 * Math.PI) / 28;
        doc.circle(scX + 40 * Math.cos(a), scY + 40 * Math.sin(a), 0.8).fill(GOLD_DIM);
      }
      doc.fillColor(GOLD).font('Times-Italic').fontSize(30)
        .text('KGB', scX - 55, scY - 21, { width: 110, align: 'center' });
      doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(6.5)
        .text('CERTIFIÉ', scX - 55, scY + 12, { width: 110, align: 'center', characterSpacing: 1.6 });
    }

    // ---- Pied de page ----
    const dateStr = (date ? new Date(date) : new Date())
      .toLocaleDateString('fr-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(10)
      .text(`Délivré le ${dateStr}`, 0, 417, { align: 'center', width: W });
    doc.fillColor(TEXT).font('Helvetica').fontSize(10)
      .text('Artisttattoo KGB — Kitigan Zibi, Québec', 0, 435, { align: 'center', width: W });
    doc.fillColor(FAINT).font('Courier').fontSize(7.5)
      .text(`N° ${numeroCertificat(email || nom, formation)}`, 0, 522, {
        align: 'center', width: W, characterSpacing: 1,
      });
    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(8)
      .text('formationtattoo.ca', 0, 540, { align: 'center', width: W, characterSpacing: 1 });

    // ---- Signature manuscrite, bas droite ----
    const sigWidth = 212;
    const sigRight = W - 62;
    const sigLineY = 492;

    doc.fillColor(GOLD).font('Times-Italic').fontSize(22)
      .text('Karl Gervais Beaudoin', sigRight - sigWidth, sigLineY - 30, { width: sigWidth, align: 'center' });
    doc.moveTo(sigRight - sigWidth, sigLineY).lineTo(sigRight, sigLineY)
      .lineWidth(0.75).strokeColor(GOLD_DIM).stroke();
    doc.fillColor(GOLD_DIM).font('Helvetica').fontSize(8)
      .text('Fondateur — Artisttattoo KGB', sigRight - sigWidth, sigLineY + 7, {
        width: sigWidth, align: 'center', characterSpacing: 0.8,
      });

    doc.end();
  });
}

module.exports = app;
