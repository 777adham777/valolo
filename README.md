# Valorant Discord Tracker

Bot webhook Discord qui suit des joueurs Valorant : resumes de matchs competitifs, leaderboard quotidien, annonces de rang et recap hebdomadaire. Tourne entierement sur GitHub Actions, stockage Turso, donnees via l'API HenrikDev.

## Setup

1. `npm install`
2. Copier `.env.example` vers `.env` et remplir les variables.
3. Creer les memes variables en secrets GitHub (`Settings > Secrets > Actions`) :
   `DISCORD_WEBHOOK_URL`, `HENRIKDEV_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
   et optionnellement `DISCORD_TEST_WEBHOOK_URL` pour les workflows de test.
4. Push, puis ajouter des joueurs via le workflow `Gerer Les Joueurs Suivis` (ou en CLI).

## CLI

```bash
npm run tracker:add-player -- "Nom#TAG" eu
npm run tracker:poll
npm run tracker:leaderboard
npm run tracker:weekly-recap
```

Autres commandes : `remove-player`, `rename-player`, `list-players`, `latest-match`, `sync`, `health`, `simulate-discord`.

## Workflows

- `poll` — verifie les nouveaux matchs toutes les 5 minutes
- `leaderboard` — classement quotidien a 19h (Europe/Paris)
- `weekly-recap` — recap de la semaine le dimanche a 20h
- `manage-players` — ajout/retrait/renommage depuis l'onglet Actions
- `health` — verification quotidienne des connexions
- `test-discord` / `simulate-discord` — tests sur un serveur Discord dedie

## Tests

```bash
npm test
```
