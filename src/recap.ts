import type { DiscordWebhookPayload, MatchStatRecord } from "./types.js";

const MIN_HITS_FOR_SNIPER_AWARD = 30;
const MIN_GAMES_FOR_GHOST_AWARD = 2;

interface PlayerWeeklyStats {
  playerId: number;
  displayName: string;
  games: number;
  wins: number;
  losses: number;
  rrNet: number | null;
  headshots: number;
  totalHits: number;
  acsValues: number[];
}

export function buildWeeklyRecapPayload(records: MatchStatRecord[]): DiscordWebhookPayload {
  if (records.length === 0) {
    return {
      embeds: [
        {
          title: "🏆 La Cérémonie de la semaine",
          description: "Personne n'a joué cette semaine. Pathétique.",
          color: 0xf1c40f,
          timestamp: new Date().toISOString()
        }
      ]
    };
  }

  const players = aggregateByPlayer(records);
  const awards = buildAwards(players);
  const summaryLines = [...players]
    .sort((left, right) => (right.rrNet ?? Number.NEGATIVE_INFINITY) - (left.rrNet ?? Number.NEGATIVE_INFINITY))
    .map((player) => {
      const rr = player.rrNet === null ? "RR inconnu" : `${player.rrNet >= 0 ? "+" : ""}${player.rrNet} RR`;
      return `**${player.displayName}** — ${player.games} game${player.games > 1 ? "s" : ""} · ${player.wins}V/${player.losses}D · ${rr}`;
    });

  return {
    embeds: [
      {
        title: "🏆 La Cérémonie de la semaine",
        description: awards.join("\n"),
        color: 0xf1c40f,
        fields: [
          {
            name: "📊 Bilan de la semaine",
            value: summaryLines.join("\n"),
            inline: false
          }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function aggregateByPlayer(records: MatchStatRecord[]): PlayerWeeklyStats[] {
  const byPlayer = new Map<number, PlayerWeeklyStats>();

  for (const record of records) {
    let stats = byPlayer.get(record.playerId);
    if (!stats) {
      stats = {
        playerId: record.playerId,
        displayName: record.displayName,
        games: 0,
        wins: 0,
        losses: 0,
        rrNet: null,
        headshots: 0,
        totalHits: 0,
        acsValues: []
      };
      byPlayer.set(record.playerId, stats);
    }

    stats.games += 1;
    if (record.didWin === true) {
      stats.wins += 1;
    } else if (record.didWin === false) {
      stats.losses += 1;
    }

    if (record.rrDelta !== null) {
      stats.rrNet = (stats.rrNet ?? 0) + record.rrDelta;
    }

    if (record.headshots !== null && record.bodyshots !== null && record.legshots !== null) {
      stats.headshots += record.headshots;
      stats.totalHits += record.headshots + record.bodyshots + record.legshots;
    }

    if (record.score !== null && record.roundsPlayed !== null && record.roundsPlayed > 0) {
      stats.acsValues.push(record.score / record.roundsPlayed);
    }
  }

  return [...byPlayer.values()];
}

function buildAwards(players: PlayerWeeklyStats[]): string[] {
  const awards: string[] = [];

  const mvp = pickBest(players.filter((player) => player.rrNet !== null && player.rrNet > 0), (player) => player.rrNet!);
  if (mvp) {
    awards.push(`🏆 **MVP de la semaine** : ${mvp.displayName} avec +${mvp.rrNet} RR. Le travail paie, parfois.`);
  }

  const boulet = pickBest(players.filter((player) => player.rrNet !== null && player.rrNet < 0), (player) => -player.rrNet!);
  if (boulet) {
    awards.push(`💀 **Boulet de la semaine** : ${boulet.displayName} (${boulet.rrNet} RR)`);
  }

  const sniper = pickBest(
    players.filter((player) => player.totalHits >= MIN_HITS_FOR_SNIPER_AWARD),
    (player) => player.headshots / player.totalHits
  );
  if (sniper) {
    awards.push(`🎯 **Le Sniper** : ${sniper.displayName} avec ${Math.round((sniper.headshots / sniper.totalHits) * 100)}% HS. Les casques adverses n'ont servi à rien.`);
  }

  const ghost = pickBest(
    players.filter((player) => player.acsValues.length >= MIN_GAMES_FOR_GHOST_AWARD),
    (player) => -averageOf(player.acsValues)
  );
  if (ghost && players.length > 1) {
    awards.push(`👻 **Le Fantôme** : ${ghost.displayName} avec ${Math.round(averageOf(ghost.acsValues))} ACS. Une discrétion presque professionnelle.`);
  }

  const noLife = pickBest(players, (player) => player.games);
  if (noLife && noLife.games >= 5) {
    awards.push(`☕ **Le No-Life** : ${noLife.displayName}. À ${noLife.games} parties, ce n'est plus un jeu mais un emploi.`);
  }

  if (awards.length === 0) {
    awards.push("Pas assez de données cette semaine pour décerner des prix. Jouez plus.");
  }

  return awards;
}

function pickBest(players: PlayerWeeklyStats[], scoreOf: (player: PlayerWeeklyStats) => number): PlayerWeeklyStats | null {
  let best: PlayerWeeklyStats | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const player of players) {
    const score = scoreOf(player);
    if (score > bestScore) {
      best = player;
      bestScore = score;
    }
  }

  return best;
}

function averageOf(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
