# AppShop

AppShop est une boutique e-commerce fictive développée avec Vue 3, Vite et Express. Elle permet d’afficher des produits, d’ajouter des articles au panier, de s’inscrire ou de se connecter, puis de passer une commande via Stripe Checkout.

## Fonctionnalités

- Catalogue de produits
- Panier avec ajout, suppression et modification des quantités
- Authentification utilisateur (inscription / connexion / déconnexion)
- Historique des commandes
- Paiement en ligne avec Stripe Checkout
- Support MySQL optionnel avec fallback vers des fichiers JSON
- API Express pour gérer les utilisateurs et les commandes

## Stack technique

- Vue 3 + Vite
- TypeScript
- Express.js
- Stripe API
- MySQL2 (optionnel)
- JSON fallback pour stockage local

## Prérequis

- Node.js 22 ou plus
- npm
- Un compte Stripe avec clé de test
- Optionnel : MySQL si vous souhaitez utiliser la base de données au lieu du stockage JSON

## Installation

1. Clonez le projet :

```bash
git clone https://github.com/ysaidmohamed/AppShop.git
cd AppShop
```

2. Installez les dépendances :

```bash
npm install
```

3. Configurez les variables d’environnement :

```bash
cp .env.example .env
```

Modifiez ensuite le fichier `.env` avec vos propres valeurs :

```env
STRIPE_SECRET_KEY=sk_test_votre_cle
PORT=4242
SESSION_SECRET=votre_secret_local
DB_HOST=
DB_PORT=
DB_NAME=
DB_USER=
DB_PASSWORD=
DB_CONNECTION_LIMIT=10
```

> Le fichier `.env` contient les vraies clés et ne doit pas être commit.

## Lancer l’application

### 1. Démarrer le serveur API

```bash
npm run server
```

### 2. Démarrer le frontend Vite

Dans un deuxième terminal :

```bash
npm run dev
```

La boutique sera disponible sur :

- Frontend : http://localhost:5173
- API : http://localhost:4242

## Tests de paiement Stripe

Pour tester le paiement localement :

1. Créez une clé Stripe de test dans votre dashboard
2. Ajoutez la clé dans le fichier `.env`
3. Déclenchez un achat depuis l’application
4. Utilisez une carte de test Stripe, par exemple :

```text
4242 4242 4242 4242
```

Avec :
- date future
- CVC arbitraire

## Base de données MySQL (optionnelle)

Le projet peut fonctionner avec un stockage local JSON, mais il supporte aussi une base MySQL si vous souhaitez un stockage plus robuste.

Le fichier SQL suivant est fourni :

- [users.sql](users.sql)

Il contient la création de la base `appshop` et les tables nécessaires pour :

- les utilisateurs
- les commandes
- les articles de commande
- les sessions et tokens de sécurité

### Utilisation

1. Connectez-vous à MySQL
2. Importez le fichier `users.sql`
3. Renseignez les variables suivantes dans votre `.env` :

```env
DB_HOST="nomdevotrehost"
DB_PORT="numerodeport"
DB_NAME=appshop
DB_USER="votrenomutilisateur"
DB_PASSWORD="votremotdepasse"
DB_CONNECTION_LIMIT=10
```

Le serveur détectera automatiquement la configuration MySQL et utilisera la base de données correspondante.

## Structure du projet

```text
AppShop/
├── src/               # Code frontend Vue
├── public/            # Fichiers statiques
├── db.json            # Catalogue produits / données de base
├── orders.json        # Stockage des commandes en fallback
├── users.sql          # Script SQL pour initialiser MySQL
├── server.js          # Serveur Express + Stripe + auth
├── .env.example       # Exemple de variables d’environnement
├── .gitignore         # Fichiers ignorés par Git
├── package.json       # Scripts du projet
├── vite.config.ts     # Configuration Vite
├── README.md          # Documentation du projet
└── index.html         # Point d’entrée HTML
```

## Scripts disponibles

```bash
npm run dev
npm run build
npm run server
npm run type-check
```

## Notes

- Si MySQL n’est pas configuré, l’application fonctionne avec les fichiers JSON de secours.
- Les sessions sont gérées côté serveur via un jeton stocké en mémoire.
- Les commandes sont enregistrées après validation du paiement.

## Auteur

Younness Said Mohamed
