# DLive !call Bot

Bot DLive qui écoute `!call "nom de la slot"` et envoie (slot + pseudo) vers votre site.

## Lancer en local
```bash
npm install
cp .env.example .env
# éditez .env et renseignez vos valeurs
npm start
```

## Variables d'environnement (.env)
- `DLIVE_AUTH_KEY` (obligatoire)
- `DLIVE_CHANNEL` (obligatoire)
- `CALLS_BASE_URL` (obligatoire, ex: https://calls-bot.onrender.com)
- `CALLS_ENDPOINT` (défaut: /api/calls)
- `CALLS_SHARED_SECRET` (optionnel)

## Déploiement sur Render (Worker)
1. Poussez ces fichiers sur un repo GitHub.
2. Créez un **Worker** ou utilisez ce `render.yaml` via *Blueprints*.
3. Définissez les env vars (ne pas committer votre .env).
4. Démarrez. Le bot tourne 24/7.
