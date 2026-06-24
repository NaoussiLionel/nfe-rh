# Déploiement NFE RH sur Koyeb (gratuit)

## 1. Créer un compte Koyeb

Va sur https://app.koyeb.com et inscris-toi avec GitHub.

## 2. Forker / cloner le dépôt

Ce dépôt GitHub : `https://github.com/NaoussiLionel/nfe-rh`

## 3. Déployer sur Koyeb

### Méthode simple (via Dashboard) :

1. Connecte-toi sur https://app.koyeb.com
2. Clique **"Create App"**
3. Choisis **"GitHub"** comme source
4. Sélectionne le dépôt `NaoussiLionel/nfe-rh`
5. **Builder** : `Dockerfile` (automatique)
6. **Port** : `3000`
7. **App name** : `nfe-rh`
8. **Region** : `Frankfurt (fra)` (le plus proche)

### Ajouter un volume persistant (obligatoire pour la DB + WhatsApp) :

1. Dans l'onglet **"Volumes"** du service :
   - Clique **"Add Volume"**
   - Nom : `data`
   - Mount path : `/data`
   - Size : `1 GB` (suffisant)
2. Ajouter une variable d'environnement :
   - `DATA_DIR` → `/data`

### Déployer

Clique **"Create App"** et attends le build (2-3 min).

## 4. Connecter WhatsApp

1. Ouvre l'URL donnée par Koyeb (ex: `https://nfe-rh.koyeb.app`)
2. Clique sur la roue dentée ⚙️ en haut à droite
3. Va dans l'onglet **"Connexion WhatsApp"**
4. Scanne le QR code avec WhatsApp (WhatsApp > Menu > Appareils liés > Lier un appareil)
5. Une fois connecté, le statut passe en vert ✅

## 5. Utilisation

- Envoie **"In"** ou **"Out"** sur WhatsApp pour pointer
- Le tableau de bord se met à jour automatiquement
- Les rapports hebdo (vendredi 15h) et mensuel (26 du mois) arrivent sur ton WhatsApp

## Rappels

- `npm start` lance le serveur en local (port 3000)
- La base de données et l'auth WhatsApp sont persistées via le volume `/data`
- Tu peux tester les pointages depuis Admin > Simulation test
- Les horaires de service se configurent dans Admin > Configuration
