import { getBottomDuoPunchline, getPunchlines, type PunchlineVariantPicker } from "./punchlines.js";
import type { DiscordWebhookPayload, LeaderboardEntry, MatchSummaryPost } from "./types.js";

// UUID de l'episode competitif courant sur media.valorant-api.com, couvre les tiers 0 a 27 (Radiant).
const COMPETITIVE_TIERS_UUID = "03621f52-342b-cf4e-4f86-9350a49c6d04";
const MAX_EMBEDS_PER_MESSAGE = 10;
const DEFAULT_EMBED_COLOR = 0x5865f2;

// Ligne de caracteres braille vides (U+2800, non trimes par Discord) ajoutee en fin de
// description : elle force chaque carte de match a la largeur maximale, pour un rendu
// homogene quelle que soit la longueur des stats ou punchlines. Seule la hauteur varie.
const EMBED_WIDTH_PAD = "⠀".repeat(56);

export function formatLeaderboard(entries: LeaderboardEntry[]): DiscordWebhookPayload[] {
  const headerEmbed = {
    author: {
      name: "VALOLO"
    },
    title: "🏆 Leaderboard Quotidien",
    description: EMBED_WIDTH_PAD,
    color: DEFAULT_EMBED_COLOR,
    timestamp: new Date().toISOString()
  };

  if (entries.length === 0) {
    return [
      {
        embeds: [
          {
            ...headerEmbed,
            description: `Aucun joueur suivi pour le moment.\n${EMBED_WIDTH_PAD}`
          }
        ]
      }
    ];
  }

  const sortedEntries = [...entries].sort(compareLeaderboardEntries);

  // Les cartes joueurs s'alignent sur la ligne la plus longue du lot (stats ou pseudo),
  // completee par des caracteres invisibles : largeur homogene sans etre etiree au maximum.
  const statLines = sortedEntries.map(formatLeaderboardLine);
  const targetLength = Math.max(
    ...statLines.map(visibleLength),
    ...sortedEntries.map((entry) => entry.displayName.length + 6)
  );

  const playerEmbeds = sortedEntries.map((entry, index) => {
    const iconUrl = rankIconUrl(entry.rankTier);
    const line = statLines[index]!;
    return {
      color: rankColor(entry.rankTier),
      author: {
        name: `${formatPosition(index)}  ${entry.displayName}`,
        ...(iconUrl ? { icon_url: iconUrl } : {})
      },
      description: line + "⠀".repeat(Math.max(0, targetLength - visibleLength(line) + 2))
    };
  });

  const allEmbeds: Array<Record<string, unknown>> = [headerEmbed, ...playerEmbeds];
  const payloads: DiscordWebhookPayload[] = [];
  for (let index = 0; index < allEmbeds.length; index += MAX_EMBEDS_PER_MESSAGE) {
    payloads.push({ embeds: allEmbeds.slice(index, index + MAX_EMBEDS_PER_MESSAGE) });
  }

  return payloads;
}

export function formatMatchSummary(posts: MatchSummaryPost[], pickVariant?: PunchlineVariantPicker): DiscordWebhookPayload {
  if (posts.length === 0) {
    throw new Error("formatMatchSummary requires at least one post");
  }

  // Classement des joueurs suivis par score de combat pour comparer leurs performances.
  const rankedPosts = [...posts].sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
  return rankedPosts.length === 1
    ? formatSingleMatchSummary(rankedPosts[0]!, pickVariant)
    : formatGroupedMatchSummary(rankedPosts, pickVariant);
}

function formatSingleMatchSummary(match: MatchSummaryPost, pickVariant?: PunchlineVariantPicker): DiscordWebhookPayload {
  const result = match.didWin === null ? "Match terminé" : match.didWin ? "Victoire" : "Défaite";
  const resultEmoji = match.didWin === null ? "🎮" : match.didWin ? "✅" : "❌";
  const score = match.teamScore !== null && match.opponentScore !== null
    ? `${match.teamScore}-${match.opponentScore}`
    : null;
  const rankIcon = rankIconUrl(match.rankTierAfter);
  const punchlines = getPunchlines(match, pickVariant);

  const statLines = [
    `⚔️ **${formatKda(match)}**${formatKdRatio(match) ? ` · ${formatKdRatio(match)} KD` : ""}`,
    `💥 **${formatAcs(match)}** ACS · 🎯 **${formatHeadshotPercent(match)}** HS`,
    `${rrEmoji(match)} ${formatRrField(match)}`
  ];

  const description = [
    statLines.join("\n"),
    ...(punchlines.length > 0 ? [punchlines.map((line) => `> ${line}`).join("\n")] : [])
  ].join("\n\n") + `\n${EMBED_WIDTH_PAD}`;

  return {
    embeds: [
      {
        author: {
          name: match.playerDisplayName,
          ...(rankIcon ? { icon_url: rankIcon } : {})
        },
        title: `${resultEmoji} ${result}${score ? ` ${score}` : ""} — ${match.mapName}`,
        description,
        color: match.didWin === true ? 0x2ecc71 : match.didWin === false ? 0xe74c3c : 0x3498db,
        ...(match.agentPortraitUrl ? { thumbnail: { url: match.agentPortraitUrl } } : {}),
        footer: {
          text: formatMatchFooter(match)
        },
        timestamp: match.startedAt ?? undefined
      }
    ]
  };
}

function formatGroupedMatchSummary(rankedPosts: MatchSummaryPost[], pickVariant?: PunchlineVariantPicker): DiscordWebhookPayload {
  const primary = rankedPosts[0]!;
  const sameOutcome = rankedPosts.every((post) => post.didWin === primary.didWin && post.teamId === primary.teamId);

  const result = primary.didWin === null ? "Match terminé" : primary.didWin ? "Victoire" : "Défaite";
  const resultEmoji = primary.didWin === null ? "🎮" : primary.didWin ? "✅" : "❌";
  const score = primary.teamScore !== null && primary.opponentScore !== null
    ? `${primary.teamScore}-${primary.opponentScore}`
    : null;
  const title = sameOutcome
    ? `${resultEmoji} ${result}${score ? ` ${score}` : ""} — ${primary.mapName}`
    : `⚔️ Match commun${score ? ` ${score}` : ""} — ${primary.mapName}`;
  const color = sameOutcome
    ? primary.didWin === true ? 0x2ecc71 : primary.didWin === false ? 0xe74c3c : 0x3498db
    : 0x3498db;

  // Les punchlines d'equipe (choke) sortent a l'identique pour chaque joueur : on dedoublonne.
  const punchlines = [...new Set(rankedPosts.flatMap((post) => getPunchlines(post, pickVariant)))];

  // Punchline de groupe : au moins deux suivis dans les 3 pires scores du lobby.
  const bottomFeeders = rankedPosts.filter((post) => post.highlights.isInBottomThreeOfLobby);
  if (bottomFeeders.length >= 2) {
    const names = bottomFeeders.map((post) => post.playerDisplayName);
    punchlines.push(getBottomDuoPunchline(names, primary.matchId, pickVariant));
  }

  const rankIcon = rankIconUrl(primary.rankTierAfter);

  const fields = rankedPosts.map((post, index) => {
    const medals = ["🥇", "🥈", "🥉"];
    const position = medals[index] ?? `#${index + 1}`;
    const outcomePrefix = sameOutcome ? "" : post.didWin === true ? "✅ " : post.didWin === false ? "❌ " : "";
    return {
      name: `${outcomePrefix}${position} ${post.playerDisplayName}${post.agentName ? ` · ${post.agentName}` : ""}`,
      value: [
        `⚔️ **${formatKda(post)}** · 💥 ${formatAcs(post)} ACS · 🎯 ${formatHeadshotPercent(post)} HS`,
        `${rrEmoji(post)} ${formatRrField(post)}`
      ].join("\n"),
      inline: false
    };
  });

  const description = [
    ...(punchlines.length > 0 ? [punchlines.map((line) => `> ${line}`).join("\n")] : []),
    EMBED_WIDTH_PAD
  ].join("\n");

  return {
    embeds: [
      {
        author: {
          name: `Match commun · ${rankedPosts.length} joueurs suivis`,
          ...(rankIcon ? { icon_url: rankIcon } : {})
        },
        title,
        description,
        color,
        // Vignette neutre : l'artwork de la carte plutot que l'agent d'un des joueurs.
        ...(primary.mapImageUrl ? { thumbnail: { url: primary.mapImageUrl } } : {}),
        fields,
        footer: {
          text: `${primary.mode} · ${formatDuration(primary.gameLengthInMs)}`
        },
        timestamp: primary.startedAt ?? undefined
      }
    ]
  };
}

function formatMatchFooter(match: MatchSummaryPost): string {
  return [match.agentName, match.mode, formatDuration(match.gameLengthInMs)]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function rrEmoji(match: MatchSummaryPost): string {
  if (match.rrDelta === null) {
    return "📊";
  }

  return match.rrDelta >= 0 ? "📈" : "📉";
}

export function formatRankChange(
  displayName: string,
  before: { rankTier: number | null; rankName: string | null },
  after: { rankTier: number; rankName: string }
): DiscordWebhookPayload {
  const iconUrl = rankIconUrl(after.rankTier);
  const description = before.rankTier === null
    ? `🎓 **${displayName}** a terminé ses placements : **${after.rankName}** !`
    : after.rankTier > before.rankTier
      ? `🎉 **${displayName}** est monté **${after.rankName}** !`
      : `💀 **${displayName}** est retombé **${after.rankName}**. F.`;

  return {
    embeds: [
      {
        description,
        color: rankColor(after.rankTier),
        ...(iconUrl ? { thumbnail: { url: iconUrl } } : {})
      }
    ]
  };
}

export function formatStreak(displayName: string, kind: "win" | "loss", count: number, isOpenEnded: boolean): DiscordWebhookPayload {
  const displayCount = isOpenEnded ? `${count}+` : `${count}`;
  return {
    embeds: [
      {
        description: kind === "win"
          ? `🔥 **${displayName}** est en feu : ${displayCount} victoires d'affilée !`
          : `🧯 **${displayName}** enchaîne ${displayCount} défaites d'affilée. Quelqu'un doit lui retirer le jeu.`,
        color: kind === "win" ? 0x2ecc71 : 0xe74c3c
      }
    ]
  };
}

function formatPosition(index: number): string {
  const medals = ["🥇", "🥈", "🥉"];
  return medals[index] ?? `#${index + 1}`;
}

function formatLeaderboardLine(entry: LeaderboardEntry): string {
  const rank = entry.rankName
    ? `**${entry.rankName}**${entry.rankingInTier !== null ? ` · ${entry.rankingInTier} RR` : ""}`
    : "**Non classé**";

  if (entry.wins !== null && entry.games !== null && entry.games > 0) {
    const losses = entry.games - entry.wins;
    const winRate = entry.winRate ?? Math.round((entry.wins / entry.games) * 1000) / 10;
    return `${rank} — ${entry.wins}V / ${losses}D · ${formatWinRate(winRate)}% WR`;
  }

  return rank;
}

function formatWinRate(winRate: number): string {
  return Number.isInteger(winRate) ? String(winRate) : winRate.toFixed(1);
}

// Longueur telle que rendue par Discord : les marqueurs de gras ne s'affichent pas.
function visibleLength(text: string): number {
  return text.replace(/\*\*/g, "").length;
}

function formatKda(match: MatchSummaryPost): string {
  if (match.kills === null || match.deaths === null || match.assists === null) {
    return "N/A";
  }

  return `${match.kills} / ${match.deaths} / ${match.assists}`;
}

function formatKdRatio(match: MatchSummaryPost): string | null {
  if (match.kills === null || match.deaths === null) {
    return null;
  }

  return match.deaths > 0 ? (match.kills / match.deaths).toFixed(2) : match.kills.toFixed(2);
}

function formatRrField(match: MatchSummaryPost): string {
  const delta = formatRrDelta(match.rrDelta);
  const after = match.rankNameAfter
    ? `${match.rankNameAfter}${match.rrAfter !== null ? ` (${match.rrAfter} RR)` : ""}`
    : null;

  if (delta && after) {
    return `**${delta} RR** → ${after}`;
  }

  if (delta) {
    return `**${delta} RR**`;
  }

  return after ?? "RR N/A";
}

function formatHeadshotPercent(match: MatchSummaryPost): string {
  if (match.headshots === null || match.bodyshots === null || match.legshots === null) {
    return "N/A";
  }

  const totalShots = match.headshots + match.bodyshots + match.legshots;
  if (totalShots === 0) {
    return "N/A";
  }

  return `${Math.round((match.headshots / totalShots) * 100)}%`;
}

function formatAcs(match: MatchSummaryPost): string {
  if (match.score === null || match.roundsPlayed === null || match.roundsPlayed <= 0) {
    return "N/A";
  }

  return String(Math.round(match.score / match.roundsPlayed));
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

function formatDuration(gameLengthInMs: number | null): string {
  if (gameLengthInMs === null) {
    return "N/A";
  }

  const totalSeconds = Math.floor(gameLengthInMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function rankIconUrl(rankTier: number | null): string | null {
  if (rankTier === null || rankTier < 0) {
    return null;
  }

  return `https://media.valorant-api.com/competitivetiers/${COMPETITIVE_TIERS_UUID}/${rankTier}/smallicon.png`;
}

function rankColor(rankTier: number | null): number {
  if (rankTier === null) {
    return DEFAULT_EMBED_COLOR;
  }

  if (rankTier >= 27) return 0xfff4b8; // Radiant
  if (rankTier >= 24) return 0xbb3d65; // Immortal
  if (rankTier >= 21) return 0x2fa47a; // Ascendant
  if (rankTier >= 18) return 0xc688f0; // Diamond
  if (rankTier >= 15) return 0x4faebc; // Platinum
  if (rankTier >= 12) return 0xecce54; // Gold
  if (rankTier >= 9) return 0xa9b3bd; // Silver
  if (rankTier >= 6) return 0xa5855d; // Bronze
  if (rankTier >= 3) return 0x6b6f70; // Iron
  return DEFAULT_EMBED_COLOR;
}

function compareLeaderboardEntries(left: LeaderboardEntry, right: LeaderboardEntry): number {
  const rankDelta = (right.rankTier ?? -1) - (left.rankTier ?? -1);
  if (rankDelta !== 0) {
    return rankDelta;
  }

  const rrDelta = (right.rankingInTier ?? -1) - (left.rankingInTier ?? -1);
  if (rrDelta !== 0) {
    return rrDelta;
  }

  return left.displayName.localeCompare(right.displayName);
}
