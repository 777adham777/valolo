import type { DiscordWebhookPayload, LeaderboardEntry, MatchSummaryPost } from "./types.js";

export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload;
export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload {
  const description = entries.length === 0
    ? "Aucun joueur suivi pour le moment."
    : entries
      .map((entry, index) => {
        const rank = entry.rankName ? `${entry.rankName}${entry.rankingInTier !== null ? ` | ${entry.rankingInTier} RR` : ""}` : "Non classe";
        const winRate = formatWinRate(entry);
        const label = getPlacementLabel(index);

        return [
          `${label} **${entry.displayName}**`,
          `> Rang : \`${rank}\``,
          `> Saison : \`${winRate}\``
        ].join("\n");
      })
      .join("\n\n");

  return {
    embeds: [
      {
        title: "Classement Valorant Quotidien",
        description,
        color: 0xe67e22,
        footer: {
          text: "Mise a jour quotidienne des joueurs suivis"
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

function getPlacementLabel(index: number): string {
  if (index === 0) {
    return "[TOP 1]";
  }

  if (index === 1) {
    return "[TOP 2]";
  }

  if (index === 2) {
    return "[TOP 3]";
  }

  return `#${index + 1}`;
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
