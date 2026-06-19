import type { DiscordWebhookPayload, LeaderboardEntry, MatchSummaryPost } from "./types.js";

export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload;
export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload {
  const description = entries.length === 0
    ? "No tracked players yet."
    : entries
      .map((entry, index) => {
        const rank = entry.rankName ? `${entry.rankName}${entry.rankingInTier !== null ? ` (${entry.rankingInTier} RR)` : ""}` : "Unranked";
        const winRate = entry.winRate !== null && entry.games !== null && entry.wins !== null
          ? `${entry.winRate.toFixed(1)}% (${entry.wins}/${entry.games})`
          : "N/A";

        return `${index + 1}. **${entry.displayName}**\nRank: ${rank}\nWin rate: ${winRate}`;
      })
      .join("\n\n");

  return {
    embeds: [
      {
        title: "Daily Valorant Leaderboard",
        description,
        color: 0xe67e22
      }
    ]
  };
}

export function formatMatchSummary(match: MatchSummaryPost): DiscordWebhookPayload {
  const result = match.didWin === null ? "completed" : match.didWin ? "won" : "lost";
  const score = match.teamScore !== null && match.opponentScore !== null
    ? `${match.teamScore}-${match.opponentScore}`
    : "Unknown score";
  const kda = [match.kills, match.deaths, match.assists].every((value) => value !== null)
    ? `${match.kills}/${match.deaths}/${match.assists}`
    : "N/A";
  const rankAfter = match.rankAfter ?? "Unknown";
  const rankBefore = match.rankBefore ?? "Unknown";
  const rrAfter = match.rrAfter !== null ? `${match.rrAfter} RR` : "N/A";
  const rrBefore = match.rrBefore !== null ? `${match.rrBefore} RR` : "N/A";
  const rrDelta = formatRrDelta(match.rrDelta);

  return {
    embeds: [
      {
        title: `${match.playerDisplayName} ${result} a Competitive match`,
        description: `**${match.mapName}**\nScore: ${score}\nKDA: ${kda}`,
        color: match.didWin === true ? 0x2ecc71 : match.didWin === false ? 0xe74c3c : 0x3498db,
        fields: [
          {
            name: "Agent",
            value: match.agentName ?? "Unknown",
            inline: true
          },
          {
            name: "Rank",
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
          text: `Match ID: ${match.matchId}`
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
