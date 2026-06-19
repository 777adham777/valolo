# Tracker Discord Valorant

Worker leger pour Discord qui suit les joueurs Valorant, publie un classement quotidien via webhook et envoie un resume quand un joueur suivi termine un match competitif.

## Fonctionnalites

- Classement quotidien avec pseudo, rang actuel et RR
- Verification automatique des matchs competitifs recents avec dedupe persistante par match poste
- Resume de match avec evolution de rang/RR
- Stockage persistant via Turso
- Workflows GitHub Actions pour automatisation et administration manuelle

## Stack

- Node.js 22.17+ or 25+
- TypeScript
- Turso via `@libsql/client`
- Discord incoming webhook
- HenrikDev Valorant API provider adapter
- GitHub Actions

## Installation

1. Installer les dependances :

   ```bash
   npm install
   ```

2. Copier `.env.example` vers `.env` et remplir les variables.

3. Ajouter un joueur :

   ```bash
   npm run tracker:add-player -- "PlayerName#TAG" eu
   ```

   Nom affiche optionnel :

   ```bash
   npm run tracker:add-player -- "PlayerName#TAG" eu "Short Name"
   ```

4. Lister les joueurs suivis :

   ```bash
   npm run tracker:list-players
   ```

5. Lancer une verification manuelle :

   ```bash
   npm run tracker:poll
   ```

6. Envoyer le classement une fois :

   ```bash
   npm run tracker:leaderboard
   ```

## CLI

- `npm run tracker:add-player -- "<name>#<tag>" <region> [displayName]`
- `npm run tracker:remove-player -- "<name>#<tag>" <region>`
- `npm run tracker:rename-player -- "<name>#<tag>" <region> [displayName]`
- `npm run tracker:list-players`
- `npm run tracker:poll`
- `npm run tracker:leaderboard`
- `npm run tracker:latest-match`
- `npm run tracker:health`
- `npm run tracker:sync`

`sync` met a jour les snapshots de rang sans poster sur Discord.

## Hebergement Gratuit

Ce repo est prevu pour :

- GitHub Actions pour la planification et l'administration manuelle
- Turso pour le stockage persistant
- Webhook Discord pour les notifications

### Configuration initiale

1. Creer une base Turso.
2. Recuperer son URL et son auth token.
3. Creer ces `Repository secrets` GitHub :
   - `DISCORD_WEBHOOK_URL`
   - `HENRIKDEV_API_KEY`
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
4. Push ce repo sur GitHub.

References officielles :

- Turso TypeScript quickstart: [docs.turso.tech/sdk/ts/quickstart](https://docs.turso.tech/sdk/ts/quickstart)
- GitHub Actions secrets: [docs.github.com/actions/security-guides/using-secrets-in-github-actions](https://docs.github.com/actions/security-guides/using-secrets-in-github-actions)

### Workflows GitHub

- `.github/workflows/poll.yml`
  Verifie les nouveaux matchs toutes les 15 minutes.
- `.github/workflows/leaderboard.yml`
  Envoie le classement quotidien a 19:00 Europe/Paris.
- `.github/workflows/manage-players.yml`
  Permet d'ajouter, retirer, renommer ou lister les joueurs depuis l'interface GitHub Actions.
- `.github/workflows/latest-match.yml`
  Reposte manuellement le dernier match competitif joue par un joueur suivi.
- `.github/workflows/health.yml`
  Verifie chaque jour la connexion Turso, HenrikDev et Discord webhook sans poster de message.

Les workflows utilisent `.github/actions/setup-tracker` pour restaurer `node_modules` depuis le cache GitHub Actions et ne lancent `npm ci` que quand `package-lock.json` change.

### Gerer les joueurs sans ton PC

Apres le push du repo :

1. Open the repository on GitHub.
2. Aller dans `Actions`.
3. Ouvrir `Gerer Les Joueurs Suivis`.
4. Click `Run workflow`.
5. Choisir :
   - `add`
   - `remove`
   - `rename`
   - `list`

Pour `add`, fournir :

- `riot_id`: `PlayerName#TAG`
- `region`: `eu`, `na`, `ap`, `kr`, `latam`, or `br`
- `display_name` optionnel

## Notes Sur Le Tracking Riot

Riot ne fournit pas de webhook public pour signaler automatiquement la fin d'un match pour ce cas d'usage. Le suivi automatique repose donc sur du polling. La couche provider isole l'acces aux donnees pour pouvoir remplacer HenrikDev plus tard sans rework du scheduler ni du format Discord.

Le poller recupere les 10 derniers matchs competitifs visibles pour chaque joueur suivi, puis poste tous les matchs non encore postes du plus ancien au plus recent. Si un joueur joue plus de 10 matchs competitifs entre deux executions du workflow, les matchs les plus anciens peuvent ne plus etre visibles dans cette fenetre. Dans ce cas, reduire l'intervalle de polling ou utiliser un worker toujours actif.

## Notes Sur GitHub Actions

- GitHub Actions peut planifier le polling au minimum toutes les 5 minutes. Ce repo utilise 15 minutes pour limiter les appels API et les minutes de runner.
- Les workflows planifies peuvent etre retardes, surtout au debut de chaque heure. GitHub peut aussi desactiver les workflows planifies sur un repo public inactif depuis 60 jours.
- Les runners standards sont gratuits sur les repositories publics. Sur un repository prive, les runs consomment le quota gratuit du compte, puis peuvent etre factures selon la configuration de facturation GitHub.
- Pour quelques joueurs, GitHub Actions toutes les 15 ou 30 minutes suffit generalement. Pour beaucoup de joueurs, des posts quasi instantanes, ou une garantie plus stricte, preferer un worker Node toujours actif chez Fly.io, Railway, Render, ou sur un petit VPS.
