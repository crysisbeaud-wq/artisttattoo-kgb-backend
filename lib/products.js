/**
 * lib/products.js
 * ---------------------------------------------------------------------------
 * Correspondance entre la clé "formation" envoyée par le frontend Hostinger
 * et le Price ID Stripe réel, ainsi que le mode de Checkout à utiliser.
 * ---------------------------------------------------------------------------
 */

const PRODUCTS = {
  debutant: {
    priceId: process.env.PRICE_ID_DEBUTANT,
    mode: 'payment',
    label: 'Formation Débutant',
  },
  intermediaire: {
    priceId: process.env.PRICE_ID_INTERMEDIAIRE,
    mode: 'payment',
    label: 'Formation Intermédiaire',
  },
  expert: {
    priceId: process.env.PRICE_ID_EXPERT,
    mode: 'payment',
    label: 'Formation Expert',
  },
  pack_complet: {
    priceId: process.env.PRICE_ID_PACK_COMPLET,
    mode: 'payment',
    label: 'Pack Complet',
  },
  session_live: {
    priceId: process.env.PRICE_ID_SESSION_LIVE,
    mode: 'payment',
    label: 'Session Live',
  },
  tattoo_pass_hebdo: {
    priceId: process.env.PRICE_ID_TATTOO_PASS_HEBDO,
    mode: 'subscription',
    label: 'Tattoo Pass — Hebdomadaire',
  },
  tattoo_pass_mensuel: {
    priceId: process.env.PRICE_ID_TATTOO_PASS_MENSUEL,
    mode: 'subscription',
    label: 'Tattoo Pass — Mensuel',
  },
  tattoo_pass_annuel: {
    priceId: process.env.PRICE_ID_TATTOO_PASS_ANNUEL,
    mode: 'subscription',
    label: 'Tattoo Pass — Annuel',
  },
};

function formationKeyFromPriceId(priceId) {
  const entry = Object.entries(PRODUCTS).find(([, v]) => v.priceId === priceId);
  return entry ? entry[0] : null;
}

module.exports = { PRODUCTS, formationKeyFromPriceId };
