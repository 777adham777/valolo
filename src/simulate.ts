import { formatLeaderboard, formatMatchSummary, formatRankChange, formatStreak } from "./format.js";
import { buildWeeklyRecapPayload } from "./recap.js";
import type {
  DiscordWebhookClient,
  LeaderboardEntry,
  MatchHighlights,
  MatchStatRecord,
  MatchSummaryPost
} from "./types.js";

// Envoie un catalogue de messages Discord bases sur des donnees 100% fictives, pour
// verifier visuellement chaque fonctionnalite sans dependre d'un vrai match ou d'un
// changement de rang reel. Ne touche ni a la base de production ni a l'API HenrikDev.
export async function runFeatureSimulation(webhook: DiscordWebhookClient): Promise<void> {
  await webhook.postMessage({
    content: "🧪 **Simulation VALOLO** — apercu de toutes les fonctionnalites avec des donnees fictives. Rien ici ne correspond a une vraie partie."
  });

  await postBanner(webhook, "📋 1/6 — Leaderboard (icones et couleurs de rang, victoires/defaites, winrate)");
  await postLeaderboardDemo(webhook);

  await postBanner(webhook, "⚔️ 2/6 — Resumes de match, un scenario different par punchline");
  await postSoloMatchDemos(webhook);

  await postBanner(webhook, "🤝 3/6 — Match commun a plusieurs joueurs suivis (classement interne + punchline d'equipe dedupliquee)");
  await postGroupedMatchDemo(webhook);

  await postBanner(webhook, "📈 4/6 — Changements de rang (placements, promotion, derank)");
  await postRankChangeDemos(webhook);

  await postBanner(webhook, "🔥 5/6 — Series de victoires / defaites");
  await postStreakDemos(webhook);

  await postBanner(webhook, "🏆 6/6 — Ceremonie hebdomadaire (MVP, Boulet, Sniper, Fantome, No-Life)");
  await postWeeklyRecapDemo(webhook);

  await webhook.postMessage({
    content: "✅ Simulation terminee. Aucune donnee reelle n'a ete lue ni modifiee."
  });
}

async function postBanner(webhook: DiscordWebhookClient, text: string): Promise<void> {
  await webhook.postMessage({ content: `**${text}**` });
  await delay(300);
}

async function postLeaderboardDemo(webhook: DiscordWebhookClient): Promise<void> {
  const entries: LeaderboardEntry[] = [
    { playerId: 1, displayName: "RadiantDemo#EU1", rankTier: 27, rankName: "Radiant", rankingInTier: 145, wins: 40, games: 60, winRate: 66.7 },
    { playerId: 2, displayName: "ImmortalDemo#EU1", rankTier: 24, rankName: "Immortal 1", rankingInTier: 210, wins: 30, games: 55, winRate: 54.5 },
    { playerId: 3, displayName: "DiamondDemo#EU1", rankTier: 19, rankName: "Diamond 2", rankingInTier: 55, wins: 20, games: 38, winRate: 52.6 },
    { playerId: 4, displayName: "GoldDemo#EU1", rankTier: 12, rankName: "Gold 1", rankingInTier: 40, wins: 12, games: 26, winRate: 46.2 },
    { playerId: 5, displayName: "PlacementsDemo#EU1", rankTier: null, rankName: null, rankingInTier: null, wins: null, games: null, winRate: null }
  ];

  for (const payload of formatLeaderboard(entries)) {
    await webhook.postMessage(payload);
    await delay(300);
  }
}

async function postSoloMatchDemos(webhook: DiscordWebhookClient): Promise<void> {
  const posts = [
    // ACE + 1v9 + Sniper
    basePost({
      playerDisplayName: "SniperDemo#EU1",
      mapName: "Bind",
      agentName: "Chamber",
      kills: 28, deaths: 9, assists: 4,
      headshots: 22, bodyshots: 14, legshots: 2,
      score: 8200, roundsPlayed: 22, damageDealt: 5200,
      didWin: true, teamScore: 13, opponentScore: 4,
      rrDelta: 24, rankTierAfter: 19, rankNameAfter: "Diamond 2", rrAfter: 12
    }, { aces: 1, teamCarryRatio: 2.1 }),

    // MVP en defaite + choke d'equipe + marathon
    basePost({
      playerDisplayName: "ChokeDemo#EU1",
      mapName: "Haven",
      agentName: "Omen",
      kills: 24, deaths: 16, assists: 8,
      headshots: 12, bodyshots: 22, legshots: 4,
      score: 6100, roundsPlayed: 24, damageDealt: 4200,
      gameLengthInMs: 52 * 60_000,
      didWin: false, teamScore: 11, opponentScore: 13,
      rrDelta: -16, rankTierAfter: 14, rankNameAfter: "Platinum 4", rrAfter: 55
    }, { isTopScoreOfMatch: true, teamChoked: true }),

    // Double ACE + smurf ACS
    basePost({
      playerDisplayName: "SmurfDemo#EU1",
      mapName: "Sunset",
      agentName: "Reyna",
      kills: 34, deaths: 8, assists: 2,
      headshots: 18, bodyshots: 30, legshots: 1,
      score: 9300, roundsPlayed: 22, damageDealt: 6100,
      didWin: true, teamScore: 13, opponentScore: 9,
      rrDelta: 28, rankTierAfter: 21, rankNameAfter: "Ascendant 1", rrAfter: 3
    }, { aces: 2 }),

    // Defaite expediee + fantome
    basePost({
      playerDisplayName: "SpeedrunDemo#EU1",
      mapName: "Abyss",
      agentName: "Cypher",
      kills: 4, deaths: 16, assists: 3,
      headshots: 5, bodyshots: 18, legshots: 2,
      score: 1800, roundsPlayed: 20, damageDealt: 1500,
      gameLengthInMs: 18 * 60_000,
      didWin: false, teamScore: 7, opponentScore: 13,
      rrDelta: -19, rankTierAfter: 11, rankNameAfter: "Silver 3", rrAfter: 12
    }),

    // Viseur bas + plus de morts + duelliste bottom frag
    basePost({
      playerDisplayName: "BouletDemo#EU1",
      mapName: "Split",
      agentName: "Jett",
      kills: 6, deaths: 22, assists: 3,
      headshots: 3, bodyshots: 28, legshots: 5,
      score: 1400, roundsPlayed: 20, damageDealt: 2600,
      didWin: false, teamScore: 7, opponentScore: 13,
      rrDelta: -21, rankTierAfter: 9, rankNameAfter: "Silver 3", rrAfter: 30
    }, { isMostDeathsInMatch: true, isDuelist: true, isBottomFragOfMatch: true }),

    // Aimant a balles + fantome (ACS < 100) + rotules
    basePost({
      playerDisplayName: "FantomeDemo#EU1",
      mapName: "Icebox",
      agentName: "Killjoy",
      kills: 4, deaths: 18, assists: 2,
      headshots: 1, bodyshots: 10, legshots: 9,
      score: 950, roundsPlayed: 21, damageDealt: 1100,
      didWin: false, teamScore: 8, opponentScore: 13,
      rrDelta: -12, rankTierAfter: 6, rankNameAfter: "Bronze 2", rrAfter: 40
    }, { firstBloods: 0, firstDeaths: 4, isMostFirstDeathsInMatch: true }),

    // Remontada + victoire en sac a dos (bottom frag mais win)
    basePost({
      playerDisplayName: "RemontadaDemo#EU1",
      mapName: "Lotus",
      agentName: "Sova",
      kills: 8, deaths: 18, assists: 7,
      headshots: 4, bodyshots: 20, legshots: 3,
      score: 2600, roundsPlayed: 23, damageDealt: 2100,
      didWin: true, teamScore: 13, opponentScore: 11,
      rrDelta: 19, rankTierAfter: 17, rankNameAfter: "Platinum 3", rrAfter: 8
    }, { teamComeback: true, isBottomFragOfMatch: true }),

    // Rouleau compresseur 13-1 + intouchable
    basePost({
      playerDisplayName: "RouleauDemo#EU1",
      mapName: "Pearl",
      agentName: "Neon",
      kills: 19, deaths: 4, assists: 6,
      headshots: 10, bodyshots: 26, legshots: 2,
      score: 4900, roundsPlayed: 14, damageDealt: 2900,
      gameLengthInMs: 22 * 60_000,
      didWin: true, teamScore: 13, opponentScore: 1,
      rrDelta: 26, rankTierAfter: 16, rankNameAfter: "Platinum 2", rrAfter: 30
    }),

    // La lecon : ecrasement subi 1-13
    basePost({
      playerDisplayName: "LeconDemo#EU1",
      mapName: "Ascent",
      agentName: "Brimstone",
      kills: 5, deaths: 13, assists: 1,
      headshots: 3, bodyshots: 12, legshots: 1,
      score: 2100, roundsPlayed: 14, damageDealt: 1600,
      gameLengthInMs: 21 * 60_000,
      didWin: false, teamScore: 1, opponentScore: 13,
      rrDelta: -22, rankTierAfter: 12, rankNameAfter: "Gold 1", rrAfter: 18
    }),

    // Le touriste : quasi aucune participation aux combats
    basePost({
      playerDisplayName: "TouristeDemo#EU1",
      mapName: "Breeze",
      agentName: "Sage",
      kills: 5, deaths: 8, assists: 2,
      headshots: 4, bodyshots: 14, legshots: 1,
      score: 2300, roundsPlayed: 18, damageDealt: 2200,
      didWin: false, teamScore: 5, opponentScore: 13,
      rrDelta: -15, rankTierAfter: 13, rankNameAfter: "Gold 2", rrAfter: 44
    })
  ];

  for (const post of posts) {
    // Variante 0 forcee : rendu deterministe pour la demo et son test.
    await webhook.postMessage(formatMatchSummary([post], () => 0));
    await delay(300);
  }
}

async function postGroupedMatchDemo(webhook: DiscordWebhookClient): Promise<void> {
  const shared = {
    matchId: "sim-grouped",
    mapName: "Fracture",
    mapImageUrl: "https://media.valorant-api.com/maps/b529448b-4d60-346e-e89e-00a4c527a405/splash.png",
    mode: "Competitive",
    didWin: false,
    teamId: "Blue",
    teamScore: 9,
    opponentScore: 13
  };

  const posts = [
    basePost({
      ...shared,
      playerDisplayName: "GroupA#EU1",
      agentName: "Sova",
      kills: 22, deaths: 17, assists: 9,
      headshots: 9, bodyshots: 24, legshots: 3,
      score: 5400, roundsPlayed: 22, damageDealt: 3700,
      rrDelta: -9, rankTierAfter: 15, rankNameAfter: "Platinum 1", rrAfter: 61
    }, { teamChoked: true }),
    basePost({
      ...shared,
      playerDisplayName: "GroupB#EU1",
      agentName: "Jett",
      kills: 14, deaths: 19, assists: 5,
      headshots: 6, bodyshots: 20, legshots: 2,
      score: 3200, roundsPlayed: 22, damageDealt: 2600,
      rrDelta: -14, rankTierAfter: 12, rankNameAfter: "Gold 1", rrAfter: 33
    }, { teamChoked: true, isInBottomThreeOfLobby: true }),
    basePost({
      ...shared,
      playerDisplayName: "GroupC#EU1",
      agentName: "Killjoy",
      kills: 10, deaths: 20, assists: 4,
      headshots: 4, bodyshots: 18, legshots: 6,
      score: 2100, roundsPlayed: 22, damageDealt: 1900,
      rrDelta: -18, rankTierAfter: 9, rankNameAfter: "Silver 3", rrAfter: 20
    }, { teamChoked: true, isInBottomThreeOfLobby: true })
  ];

  await webhook.postMessage(formatMatchSummary(posts, () => 0));
  await delay(300);
}

async function postRankChangeDemos(webhook: DiscordWebhookClient): Promise<void> {
  await webhook.postMessage(formatRankChange(
    "PlacementDemo#EU1",
    { rankTier: null, rankName: null },
    { rankTier: 12, rankName: "Gold 1" }
  ));
  await delay(300);

  await webhook.postMessage(formatRankChange(
    "PromotionDemo#EU1",
    { rankTier: 12, rankName: "Gold 1" },
    { rankTier: 15, rankName: "Platinum 1" }
  ));
  await delay(300);

  await webhook.postMessage(formatRankChange(
    "DerankDemo#EU1",
    { rankTier: 21, rankName: "Ascendant 1" },
    { rankTier: 18, rankName: "Diamond 3" }
  ));
  await delay(300);
}

async function postStreakDemos(webhook: DiscordWebhookClient): Promise<void> {
  // Un exemple par palier, variante 0 forcee pour un rendu deterministe.
  await webhook.postMessage(formatStreak("StreakDemo#EU1", "win", 3, false, () => 0));
  await delay(300);
  await webhook.postMessage(formatStreak("OnFireDemo#EU1", "win", 10, true, () => 0));
  await delay(300);
  await webhook.postMessage(formatStreak("TiltDemo#EU1", "loss", 4, false, () => 0));
  await delay(300);
  await webhook.postMessage(formatStreak("NaufrageDemo#EU1", "loss", 6, true, () => 0));
  await delay(300);
}

async function postWeeklyRecapDemo(webhook: DiscordWebhookClient): Promise<void> {
  const records: MatchStatRecord[] = [
    // MVP : +48 RR net sur 2 games
    fakeRecord({ playerId: 101, displayName: "MvpDemo#EU1", matchId: "sim-mvp-1", rrDelta: 26, kills: 22, deaths: 12, assists: 6, headshots: 10, bodyshots: 20, legshots: 2, score: 5200, roundsPlayed: 22, damageDealt: 3600, didWin: true }),
    fakeRecord({ playerId: 101, displayName: "MvpDemo#EU1", matchId: "sim-mvp-2", rrDelta: 22, kills: 18, deaths: 14, assists: 7, headshots: 8, bodyshots: 22, legshots: 3, score: 4700, roundsPlayed: 24, damageDealt: 3200, didWin: true }),

    // Boulet : -52 RR net sur 2 games
    fakeRecord({ playerId: 102, displayName: "BouletDemo2#EU1", matchId: "sim-boulet-1", rrDelta: -27, kills: 6, deaths: 20, assists: 2, headshots: 3, bodyshots: 18, legshots: 5, score: 1600, roundsPlayed: 22, damageDealt: 1800, didWin: false }),
    fakeRecord({ playerId: 102, displayName: "BouletDemo2#EU1", matchId: "sim-boulet-2", rrDelta: -25, kills: 8, deaths: 19, assists: 3, headshots: 2, bodyshots: 19, legshots: 6, score: 1900, roundsPlayed: 23, damageDealt: 2000, didWin: false }),

    // Sniper : gros HS% sur une game
    fakeRecord({ playerId: 103, displayName: "SniperWeek#EU1", matchId: "sim-sniper-1", rrDelta: 15, kills: 24, deaths: 11, assists: 3, headshots: 26, bodyshots: 14, legshots: 2, score: 6800, roundsPlayed: 21, damageDealt: 4400, didWin: true }),

    // Fantome : pire ACS moyen sur 2 games
    fakeRecord({ playerId: 104, displayName: "FantomeWeek#EU1", matchId: "sim-fantome-1", rrDelta: -6, kills: 3, deaths: 17, assists: 1, headshots: 1, bodyshots: 9, legshots: 2, score: 700, roundsPlayed: 21, damageDealt: 900, didWin: false }),
    fakeRecord({ playerId: 104, displayName: "FantomeWeek#EU1", matchId: "sim-fantome-2", rrDelta: -4, kills: 2, deaths: 18, assists: 2, headshots: 0, bodyshots: 8, legshots: 1, score: 600, roundsPlayed: 22, damageDealt: 800, didWin: false }),

    // No-Life : 5 games, stats modestes
    ...Array.from({ length: 5 }, (_unused, index) => fakeRecord({
      playerId: 105,
      displayName: "NoLifeDemo#EU1",
      matchId: `sim-nolife-${index + 1}`,
      rrDelta: index % 2 === 0 ? -3 : 4,
      kills: 15, deaths: 15, assists: 5,
      headshots: 6, bodyshots: 20, legshots: 3,
      score: 3600, roundsPlayed: 23, damageDealt: 2900,
      didWin: index % 2 === 1
    }))
  ];

  await webhook.postMessage(buildWeeklyRecapPayload(records));
  await delay(300);
}

function baseHighlights(overrides: Partial<MatchHighlights> = {}): MatchHighlights {
  return {
    aces: 0,
    quadKills: 0,
    firstBloods: 1,
    firstDeaths: 1,
    isMostFirstDeathsInMatch: false,
    isMostDeathsInMatch: false,
    isBottomFragOfMatch: false,
    isTopScoreOfMatch: false,
    isInBottomThreeOfLobby: false,
    teamCarryRatio: null,
    isDuelist: false,
    teamChoked: false,
    teamComeback: false,
    ...overrides
  };
}

function basePost(overrides: Partial<Omit<MatchSummaryPost, "highlights">>, highlights: Partial<MatchHighlights> = {}): MatchSummaryPost {
  return {
    matchId: `sim-${Math.random().toString(36).slice(2, 10)}`,
    mode: "Competitive",
    mapName: "Ascent",
    mapImageUrl: "https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png",
    startedAt: new Date().toISOString(),
    seasonShort: "e11a4",
    gameLengthInMs: 1_800_000,
    agentName: "Sova",
    agentPortraitUrl: "https://media.valorant-api.com/agents/320b2a48-4d9b-a075-30f1-1f93a9b638fa/displayicon.png",
    teamId: "Blue",
    kills: 20,
    deaths: 14,
    assists: 6,
    headshots: 10,
    bodyshots: 25,
    legshots: 3,
    score: 5200,
    damageDealt: 3400,
    roundsPlayed: 22,
    teamScore: 13,
    opponentScore: 9,
    didWin: true,
    rosterPuuids: [],
    playerDisplayName: "Demo#EU1",
    rrDelta: 18,
    rankTierAfter: 15,
    rankNameAfter: "Platinum 1",
    rrAfter: 42,
    ...overrides,
    highlights: baseHighlights(highlights)
  };
}

function fakeRecord(overrides: Partial<MatchStatRecord> & { playerId: number; displayName: string; matchId: string }): MatchStatRecord {
  return {
    startedAt: new Date().toISOString(),
    didWin: null,
    rrDelta: null,
    kills: null,
    deaths: null,
    assists: null,
    headshots: null,
    bodyshots: null,
    legshots: null,
    score: null,
    roundsPlayed: null,
    damageDealt: null,
    ...overrides
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
