# Artisttattoo KGB — Backend Stripe

Backend Express.js déployé sur Vercel (serverless), qui gère les paiements
Stripe, le déblocage des formations, la validation des examens et les
certificats. Le site vitrine reste sur Hostinger (statique) et appelle ce
backend en `fetch()`.

---

## 1. Déploiement sur Vercel

```bash
cd backend
npm install
npm i -g vercel      # si pas déjà installé
vercel                # déploiement de test (preview)
vercel --prod          # déploiement en production
```

Dans **Vercel → ton projet → Settings → Environment Variables**, ajoute
(exactement ces noms, déjà utilisés dans le code) :

```
STRIPE_SECRET_KEY
STRIPE_PUBLIC_KEY
STRIPE_WEBHOOK_SECRET
PRICE_ID_DEBUTANT
PRICE_ID_INTERMEDIAIRE
PRICE_ID_EXPERT
PRICE_ID_PACK_COMPLET
PRICE_ID_SESSION_LIVE
PRICE_ID_TATTOO_PASS_HEBDO
PRICE_ID_TATTOO_PASS_MENSUEL
PRICE_ID_TATTOO_PASS_ANNUEL
ALLOWED_ORIGIN            → https://formationtattoo.ca
```

⚠️ `STRIPE_SECRET_KEY` ne doit **jamais** apparaître dans le code du site
Hostinger (HTML/CSS/JS) ni être committée dans Git. Elle ne vit que dans les
variables d'environnement Vercel, lues côté serveur par `api/server.js` et
`api/webhook.js`.

Après déploiement, note ton URL Vercel, par exemple :
`https://artisttattoo-kgb-backend.vercel.app`

---

## 2. Configuration Stripe

### 2.1 Vérifier les Price ID
Les 8 Price ID fournis doivent correspondre à des **Prices actifs** dans ton
Dashboard Stripe (Produits → chaque produit → Prices). Les formations
Débutant/Intermédiaire/Expert/Pack/Session live doivent être en mode
**paiement unique** ; les trois Tattoo Pass doivent être en mode
**récurrent** (semaine / mois / année). Le code choisit automatiquement le
bon mode Checkout (`payment` vs `subscription`) selon le produit — voir
`lib/products.js`.

### 2.2 Créer le Webhook
Dashboard Stripe → **Developers → Webhooks → Add endpoint** :

- URL : `https://TON-PROJET.vercel.app/webhook`
- Événements à écouter :
  - `checkout.session.completed`
  - `payment_intent.succeeded`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`

Stripe te donne un **Signing secret** (`whsec_...`) au moment de la
création — copie-le dans la variable Vercel `STRIPE_WEBHOOK_SECRET`.

### 2.3 Tester en local (optionnel)
```bash
stripe listen --forward-to localhost:3000/webhook
stripe trigger checkout.session.completed
```

---

## 3. Intégration côté Hostinger (frontend statique)

Le site Hostinger ne contient **aucune clé secrète**. Il appelle simplement
ton backend Vercel en `fetch()`. Exemple pour un bouton d'achat (à adapter
dans `script.js`, sans toucher au reste du fichier) :

```javascript
const BACKEND_URL = "https://TON-PROJET.vercel.app";

async function acheterFormation(formation, email) {
  const res = await fetch(`${BACKEND_URL}/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ formation, email }) // email optionnel mais recommandé
  });
  const data = await res.json();
  if (data.url) {
    window.location.href = data.url; // redirection vers Stripe Checkout
  } else {
    alert(data.error || "Erreur de paiement.");
  }
}
```

Les clés valides pour `formation` sont : `debutant`, `intermediaire`,
`expert`, `pack_complet`, `session_live`, `tattoo_pass_hebdo`,
`tattoo_pass_mensuel`, `tattoo_pass_annuel`.

### Vérifier l'accès sur une page protégée
```javascript
async function verifierAcces(email, formation) {
  const res = await fetch(`${BACKEND_URL}/verify-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, formation })
  });
  const data = await res.json();
  return data.access; // true / false
}
```

### ⚠️ Limite structurelle importante à connaître
Le site Hostinger étant 100% statique, `verifierAcces()` ne peut que
**cacher/afficher** du contenu déjà présent dans le HTML — un visiteur qui
lit le code source verrait quand même le contenu caché. Pour une protection
réelle (contenu des chapitres, questions/réponses d'examen), il faut que ce
contenu **ne soit pas** dans le HTML Hostinger, mais servi dynamiquement par
le backend Vercel après vérification (ex : une route `GET /chapitre/:id`
protégée par email). Le backend actuel fournit déjà `/verify-access` comme
brique de base ; migrer le contenu des chapitres/examens vers des routes
protégées côté backend est la suite logique si tu veux une protection
réellement étanche. Dis-moi si tu veux que je construise ça ensuite.

---

## 4. Résumé des routes du backend

| Méthode | Route                        | Body / Params                              | Description |
|---------|-------------------------------|---------------------------------------------|--------------|
| POST    | `/create-checkout-session`   | `{ formation, email? }`                     | Crée une session Stripe Checkout, renvoie `{ url }` |
| POST    | `/verify-access`             | `{ email, formation? }`                     | Renvoie `{ access: true/false }` ou l'objet complet |
| POST    | `/validate-exam`             | `{ email, formation, score }`               | Valide l'examen (≥80%), génère le certificat |
| GET     | `/certificat/:email`         | `?formation=debutant`                       | Télécharge le certificat PDF |
| GET     | `/health`                    | —                                            | `{ status: "ok" }` |
| POST    | `/webhook`                   | (géré par Stripe)                            | Réception des événements Stripe |

## 5. Redirections configurées

- Succès : `https://formationtattoo.ca/success?formation=debutant&session_id=...`
  (idem pour `intermediaire`, `expert`, etc. — la clé `formation` correspond
  à celle envoyée à `/create-checkout-session`)
- Échec/Annulation : `https://formationtattoo.ca/payment-failed`

Crée ces deux pages sur Hostinger (même simples) pour accueillir le
visiteur après son passage sur Stripe.

## 6. Limite connue : stockage `access.json`

Voir les commentaires en tête de `lib/store.js`. En résumé : ce fichier
fonctionne pour développer/tester, mais sur Vercel le système de fichiers
n'est pas garanti persistant en production. Pour un lancement réel avec de
vrais clients payants, remplace `lib/store.js` par une vraie base de données
(Vercel Postgres, Vercel KV, Supabase...) — toutes les fonctions du module
sont déjà `async`, donc le reste du code (`server.js`, `webhook.js`) n'a pas
à changer.
