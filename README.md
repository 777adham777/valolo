# Valorant Discord Tracker

Lightweight Valorant tracking worker that polls player state, posts a daily leaderboard to Discord through a webhook, and posts a match summary whenever a tracked player finishes a new competitive match.

## Features

- Daily leaderboard with tracked player name, current rank, RR, and competitive win rate
- Competitive match polling with strict dedupe by latest processed match ID
- Rank delta rendering based on stored pre-match and post-match snapshots
- Turso-backed persistent state
- GitHub Actions scheduling and manual admin workflows

## Stack

- Node.js 22.17+ or 25+
- TypeScript
- Turso via `@libsql/client`
- Discord incoming webhook
- HenrikDev Valorant API provider adapter
- GitHub Actions

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your values.

3. Add a player:

   ```bash
   npm run tracker:add-player -- "PlayerName#TAG" eu
   ```

   Optional display name:

   ```bash
   npm run tracker:add-player -- "PlayerName#TAG" eu "Short Name"
   ```

4. Inspect tracked players:

   ```bash
   npm run tracker:list-players
   ```

5. Run the poller once:

   ```bash
   npm run tracker:poll
   ```

6. Post the daily leaderboard once:

   ```bash
   npm run tracker:leaderboard
   ```

## CLI

- `npm run tracker:add-player -- "<name>#<tag>" <region> [displayName]`
- `npm run tracker:remove-player -- "<name>#<tag>" <region>`
- `npm run tracker:list-players`
- `npm run tracker:poll`
- `npm run tracker:leaderboard`
- `npm run tracker:sync`

`sync` refreshes tracked player rank and win rate without posting anything.

## Free Hosted Setup

This repo is now aimed at:

- GitHub Actions for scheduling and manual admin runs
- Turso for persistent storage
- Discord webhook for notifications

### One-time setup

1. Create a Turso database.
2. Get its database URL and auth token.
3. Create these GitHub repository secrets:
   - `DISCORD_WEBHOOK_URL`
   - `HENRIKDEV_API_KEY`
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
4. Push this repo to GitHub.

Official references:

- Turso TypeScript quickstart: [docs.turso.tech/sdk/ts/quickstart](https://docs.turso.tech/sdk/ts/quickstart)
- GitHub Actions secrets: [docs.github.com/actions/security-guides/using-secrets-in-github-actions](https://docs.github.com/actions/security-guides/using-secrets-in-github-actions)

### GitHub workflows

- `.github/workflows/poll.yml`
  Runs every 5 minutes and posts new competitive match summaries.
- `.github/workflows/leaderboard.yml`
  Runs once per day and posts the daily leaderboard.
- `.github/workflows/manage-players.yml`
  Lets you add, remove, or list players from the GitHub Actions UI with `workflow_dispatch`.

### Managing players without your computer

After pushing the repo:

1. Open the repository on GitHub.
2. Go to `Actions`.
3. Open `Manage Tracked Players`.
4. Click `Run workflow`.
5. Choose:
   - `add`
   - `remove`
   - `list`

For `add`, provide:

- `riot_id`: `PlayerName#TAG`
- `region`: `eu`, `na`, `ap`, `kr`, `latam`, or `br`
- optional `display_name`

## Notes On Riot Tracking

Riot does not provide a public push webhook for player match completion in this use case, so automatic tracking is polling-based. The provider layer isolates data access so you can swap away from HenrikDev later without rewriting the scheduler or Discord formatting.
