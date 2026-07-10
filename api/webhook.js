/**
 * api/webhook.js
 * ---------------------------------------------------------------------------
 * Endpoint Stripe Webhook — https://ton-projet.vercel.app/webhook
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const Stripe = require('stripe');

const store = require('../lib/store');
const { formationKeyFromPriceId } = require('../lib/products');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (err) {
    console.error('❌ Signature webhook invalide :', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session);
        break;
      }

      case 'payment_intent.succeeded': {
        const intent = event.data.object;
        console.log(`✅ Paiement confirmé : ${intent.id} (${intent.amount / 100} ${intent.currency})`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await handleSubscriptionEnded(subscription);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await handlePaymentFailed(invoice);
        break;
      }

      default:
        console.log(`ℹ️ Événement Stripe non traité : ${event.type}`);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Erreur de traitement du webhook :', err);
    return res.status(200).json({ received: true, warning: 'Erreur interne loguée.' });
  }
});

async function handleCheckoutCompleted(session) {
  const email = session.customer_email || session.customer_details?.email;
  if (!email) {
    console.error('checkout.session.completed sans email — impossible de débloquer l\'accès.', session.id);
    return;
  }

  let formationKey = session.metadata?.formation;

  if (!formationKey) {
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
    const priceId = lineItems.data[0]?.price?.id;
    formationKey = formationKeyFromPriceId(priceId);
  }

  if (!formationKey) {
    console.error('Impossible de déterminer la formation achetée pour la session', session.id);
    return;
  }

  await store.setAccess(email, formationKey, true);

  if (formationKey === 'pack_complet') {
    await store.setAccess(email, 'debutant', true);
    await store.setAccess(email, 'intermediaire', true);
    await store.setAccess(email, 'expert', true);
  }

  console.log(`✅ Accès débloqué : ${email} → ${formationKey}`);
}

async function handleSubscriptionEnded(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const formationKey = formationKeyFromPriceId(priceId);
  const customer = await stripe.customers.retrieve(subscription.customer);
  const email = customer?.email;

  if (email && formationKey) {
    await store.setAccess(email, formationKey, false);
    console.log(`⛔ Accès Tattoo Pass révoqué (abonnement terminé) : ${email} → ${formationKey}`);
  }
}

async function handlePaymentFailed(invoice) {
  const email = invoice.customer_email;
  const priceId = invoice.lines?.data?.[0]?.price?.id;
  const formationKey = formationKeyFromPriceId(priceId);

  if (email && formationKey) {
    await store.setAccess(email, formationKey, false);
    console.log(`⛔ Accès Tattoo Pass révoqué (paiement échoué) : ${email} → ${formationKey}`);
  }
}

module.exports = app;
