import type { DiscordWebhookPayload, LeaderboardEntry, MatchSummaryPost } from "./types.js";

export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload;
export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload {
  const description = entries.length === 0
    ? "Aucun joueur suivi pour le moment."
    : entries
      .map((entry, index) => {
        const rank = entry.rankName ? `${entry.rankName}${entry.rankingInTier !== null ? ` · ${entry.rankingInTier} RR` : ""}` : "Non classe";
        const winRate = formatWinRate(entry);
        const icon = getPlacementIcon(index);

        return [
          `${icon} **${entry.displayName}**`,
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
  const result = match.didWin === null ? "a termine" : match.didWin ? "a gagne" : "a perdu";
  const score = match.teamScore !== null && match.opponentScore !== null
    ? `${match.teamScore}-${match.opponentScore}`
    : "Score inconnu";
  const kda = [match.kills, match.deaths, match.assists].every((value) => value !== null)
    ? `${match.kills}/${match.deaths}/${match.assists}`
    : "N/A";
  const rankAfter = match.rankAfter ?? "Inconnu";
  const rankBefore = match.rankBefore ?? "Inconnu";
  const rrAfter = match.rrAfter !== null ? `${match.rrAfter} RR` : "N/A";
  const rrBefore = match.rrBefore !== null ? `${match.rrBefore} RR` : "N/A";
  const rrDelta = formatRrDelta(match.rrDelta);

  return {
    embeds: [
      {
        title: `${match.playerDisplayName} ${result} un match competitif`,
        description: `**${match.mapName}**\nScore : ${score}\nKDA : ${kda}`,
        color: match.didWin === true ? 0x2ecc71 : match.didWin === false ? 0xe74c3c : 0x3498db,
        fields: [
          {
            name: "Agent",
            value: match.agentName ?? "Inconnu",
            inline: true
          },
          {
            name: "Rang",
            value: `${rankBefore} -> ${rankAfter}`,
            inline: true
          },
          {
            name: "RR",
            value: `${rrBefore} -> ${rrAfter}${rrDelta ? ` (${rrDelta})` : ""}`,
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
  return `${roundedWinRate}%WR · ${entry.wins}-${losses}`;
}

function getPlacementIcon(index: number): string {
  if (index === 0) {
    return "🥇";
  }

  if (index === 1) {
    return "🥈";
  }

  if (index === 2) {
    return "🥉";
  }

  return `#${index + 1}`;
}
