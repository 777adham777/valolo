import type { DiscordWebhookPayload, LeaderboardEntry, MatchSummaryPost } from "./types.js";

export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload;
export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload {
  if (entries.length === 0) {
    return {
      embeds: [
        {
          title: "Classement Valorant Quotidien",
          description: "Aucun joueur suivi pour le moment.",
          color: 0xe67e22,
          footer: {
            text: "Mise a jour quotidienne des joueurs suivis"
          }
        }
      ]
    };
  }

  const podium = entries
    .slice(0, 3)
    .map((entry, index) => `${getPlacementLabel(index)} **${entry.displayName}**\n${formatRank(entry)}\n${formatWinRate(entry)}`)
    .join("\n\n");

  const tableLines = [
    `${padRight("#", 4)}${padRight("Joueur", 16)}${padRight("Rang", 24)}WR`,
    ...entries.map((entry, index) => {
      const placement = String(index + 1);
      const player = truncate(entry.displayName, 15);
      const rank = truncate(formatRank(entry), 23);
      const winRate = formatWinRate(entry);

      return `${padRight(placement, 4)}${padRight(player, 16)}${padRight(rank, 24)}${winRate}`;
    })
  ];

  const tableFields = splitTableIntoFields(tableLines);

  return {
    embeds: [
      {
        title: "Classement Valorant Quotidien",
        description: `**Podium**\n${podium}`,
        color: 0xe67e22,
        fields: tableFields,
        footer: {
          text: `${entries.length} joueur(s) suivi(s)`
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
  return entry.rankName ? `${entry.rankName}${entry.rankingInTier !== null ? ` ${entry.rankingInTier}RR` : ""}` : "Non classe";
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

function splitTableIntoFields(lines: string[]): Array<Record<string, unknown>> {
  const fields: Array<Record<string, unknown>> = [];
  let currentChunk: string[] = [];

  for (const line of lines) {
    const candidate = currentChunk.length === 0
      ? `\`\`\`\n${line}\n\`\`\``
      : `\`\`\`\n${currentChunk.join("\n")}\n${line}\n\`\`\``;

    if (candidate.length > 1024 && currentChunk.length > 0) {
      fields.push({
        name: fields.length === 0 ? "Classement" : "Suite",
        value: `\`\`\`\n${currentChunk.join("\n")}\n\`\`\``,
        inline: false
      });
      currentChunk = [line];
    } else {
      currentChunk.push(line);
    }
  }

  if (currentChunk.length > 0) {
    fields.push({
      name: fields.length === 0 ? "Classement" : "Suite",
      value: `\`\`\`\n${currentChunk.join("\n")}\n\`\`\``,
      inline: false
    });
  }

  return fields;
}

function padRight(value: string, length: number): string {
  return value.padEnd(length, " ");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(maxLength - 1, 1))}…`;
}
