import type { DiscordWebhookPayload, LeaderboardEntry, MatchSummaryPost } from "./types.js";

export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload;
export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload {
  const sortedEntries = [...entries].sort(compareLeaderboardEntries);

  if (sortedEntries.length === 0) {
    return {
      embeds: [
        {
          author: {
            name: "VALOLO"
          },
          title: "Leaderboard Quotidien",
          description: "Aucun joueur suivi pour le moment.",
          color: 0x5865f2,
          footer: {
            text: "Aujourdhui"
          }
        }
      ]
    };
  }

  const description = sortedEntries
    .map((entry, index) => {
      const titleLine = `**${index + 1} - ${formatRankPrefix(entry)} ${entry.displayName}**`;
      const subtitleLine = `${formatRank(entry)} | ${formatWinRate(entry)}`;
      return `${titleLine}\n${subtitleLine}`;
    })
    .join("\n\n");

  return {
    embeds: [
      {
        author: {
          name: "VALOLO"
        },
        title: "Leaderboard Quotidien",
        description,
        color: 0x5865f2,
        footer: {
          text: "Aujourdhui"
        }
      }
    ]
  };
}

export function formatMatchSummary(match: MatchSummaryPost): DiscordWebhookPayload {
  const result = match.didWin === null ? "Match termine" : match.didWin ? "Victoire" : "Defaite";
  const score = match.teamScore !== null && match.opponentScore !== null
    ? `${match.teamScore}-${match.opponentScore}`
    : "Inconnu";
  const kda = [match.kills, match.deaths, match.assists].every((value) => value !== null)
    ? `${match.kills}/${match.deaths}/${match.assists}`
    : "N/A";
  const rrDelta = formatRrDelta(match.rrDelta);
  const duration = formatDuration(match.gameLengthInMs);

  return {
    embeds: [
      {
        title: match.playerDisplayName,
        description: `${result} en competitif`,
        color: match.didWin === true ? 0x2ecc71 : match.didWin === false ? 0xe74c3c : 0x3498db,
        thumbnail: match.agentPortraitUrl ? { url: match.agentPortraitUrl } : undefined,
        fields: [
          {
            name: "Carte",
            value: match.mapName,
            inline: true
          },
          {
            name: "Score",
            value: score,
            inline: true
          },
          {
            name: "KDA",
            value: kda,
            inline: true
          },
          {
            name: "Duree",
            value: duration,
            inline: true
          },
          {
            name: "RR",
            value: rrDelta ? `${rrDelta} RR` : "N/A",
            inline: true
          },
          {
            name: "Agent",
            value: match.agentName ?? "Inconnu",
            inline: true
          }
        ],
        footer: {
          text: `ID du match : ${match.matchId}`
        },
        timestamp: match.startedAt ?? undefined
      }
    ]
  };
}

function formatRrDelta(delta: number | null): string | null {
  if (delta === null) {
    return null;
  }

  if (delta > 0) {
    return `+${delta}`;
  }

  return `${delta}`;
}

function formatWinRate(entry: LeaderboardEntry): string {
  if (entry.winRate === null || entry.games === null || entry.wins === null) {
    return "N/A";
  }

  const losses = Math.max(entry.games - entry.wins, 0);
  const roundedWinRate = Number.isInteger(entry.winRate) ? `${entry.winRate}` : entry.winRate.toFixed(1);
  return `${roundedWinRate}%WR | ${entry.wins}-${losses}`;
}

function formatRank(entry: LeaderboardEntry): string {
  return entry.rankName ? `${entry.rankName.toUpperCase()}${entry.rankingInTier !== null ? ` - ${entry.rankingInTier} RR` : ""}` : "NON CLASSE";
}

function formatRankPrefix(entry: LeaderboardEntry): string {
  const tier = entry.rankTier ?? 0;

  if (tier >= 27) {
    return "[R]";
  }

  if (tier >= 24) {
    return "[I]";
  }

  if (tier >= 21) {
    return "[A]";
  }

  if (tier >= 18) {
    return "[D]";
  }

  if (tier >= 15) {
    return "[P]";
  }

  if (tier >= 12) {
    return "[G]";
  }

  if (tier >= 9) {
    return "[S]";
  }

  if (tier >= 6) {
    return "[B]";
  }

  if (tier >= 3) {
    return "[F]";
  }

  if (tier > 0) {
    return "[?]";
  }

  return "[NC]";
}

function formatDuration(gameLengthInMs: number | null): string {
  if (gameLengthInMs === null) {
    return "N/A";
  }

  const totalSeconds = Math.floor(gameLengthInMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function compareLeaderboardEntries(left: LeaderboardEntry, right: LeaderboardEntry): number {
  const rankDelta = (right.rankTier ?? -1) - (left.rankTier ?? -1);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  const winRateDelta = (right.winRate ?? -1) - (left.winRate ?? -1);
  if (winRateDelta !== 0) {
    return winRateDelta;
  }

  return left.displayName.localeCompare(right.displayName);
}
