# Commentaires — « Témoignages des Éveillés »

Service de commentaires du blog : un Cloudflare Worker + une base SQLite intégrée
(Durable Object), dans l'offre gratuite de Cloudflare.

- Les lecteurs commentent avec un simple pseudo, sans compte.
- Chaque commentaire attend la validation sur `/outils/moderation.html`.
- La Rédaction peut répondre depuis la même page (réponse publiée directement, badge « Rédaction »).
- Anti-spam : champ piège invisible, 3 commentaires max par IP toutes les 10 minutes,
  2 liens max par message. Les IP ne sont jamais stockées en clair (empreinte effacée après 30 jours).

## Déploiement

Automatique à chaque modification de ce dossier (`.github/workflows/commentaires.yml`).
Secrets GitHub requis : `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `COMMENTS_ADMIN_TOKEN`
(+ `DISCORD_WEBHOOK` facultatif). L'adresse du Worker est écrite dans `assets/comments-config.js`.

## Réglages (`wrangler.toml`)

- `ALLOWED_ORIGINS` : domaines autorisés à appeler l'API.
- `AUTO_APPROVE = "true"` : publier sans modération (déconseillé pour un site satirique).

## Test en local

    cd commentaires
    echo 'ADMIN_TOKEN="test"' > .dev.vars
    npx wrangler@4 dev
