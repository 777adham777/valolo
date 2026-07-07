export type Region = "ap" | "br" | "eu" | "kr" | "latam" | "na";

export interface TrackedPlayer {
  id: number;
  gameName: string;
  tagLine: string;
  region: Region;
  puuid: string;
  displayName: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerState {
  trackedPlayerId: number;
  rankTier: number | null;
  rankName: string | null;
  rankingInTier: number | null;
  wins: number | null;
  games: number | null;
  winRate: number | null;
  lastProcessedMatchId: string | null;
  lastCheckedAt: string | null;
  updatedAt: string;
}

export interface PlayerIdentity {
  gameName: string;
  tagLine: string;
  region: Region;
  puuid: string;
}

export interface ResolvedPlayer extends PlayerIdentity {
  displayName: string;
}

export interface PlayerSnapshot {
  rankTier: number | null;
  rankName: string | null;
  rankingInTier: number | null;
  lastRrChange: number | null;
  wins: number | null;
  games: number | null;
}

export interface MatchSummary {
  matchId: string;
  mode: string;
  mapName: string;
  mapImageUrl: string | null;
  startedAt: string | null;
  seasonShort: string | null;
  gameLengthInMs: number | null;
  agentName: string | null;
  agentPortraitUrl: string | null;
  teamId: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  headshots: number | null;
  bodyshots: number | null;
  legshots: number | null;
  score: number | null;
  damageDealt: number | null;
  roundsPlayed: number | null;
  teamScore: number | null;
  opponentScore: number | null;
  didWin: boolean | null;
  highlights: MatchHighlights;
}

// Faits marquants du joueur suivi, calcules a partir du payload complet du match
// (les 10 joueurs, les rounds et les kill events).
export interface MatchHighlights {
  aces: number;
  firstBloods: number | null;
  firstDeaths: number | null;
  isMostFirstDeathsInMatch: boolean;
  isMostDeathsInMatch: boolean;
  isBottomFragOfMatch: boolean;
  isTopScoreOfMatch: boolean;
  // parmi les 3 pires scores d'un lobby d'au moins 8 joueurs
  isInBottomThreeOfLobby: boolean;
  // score du joueur / meilleur score d'un coequipier (>1 = il porte l'equipe)
  teamCarryRatio: number | null;
  isDuelist: boolean;
  // l'equipe menait largement (avance >= 6 rounds avec au moins 9 rounds gagnes) avant de perdre
  teamChoked: boolean;
  // l'equipe etait largement menee (l'adversaire avait >= 9 rounds et 6 d'avance) et a gagne
  teamComeback: boolean;
}

export interface MatchRrChange {
  matchId: string;
  startedAt: string | null;
  rrChange: number | null;
  rrAfter: number | null;
  rankTierAfter: number | null;
  rankNameAfter: string | null;
}

export interface MatchSummaryPost extends MatchSummary {
  playerDisplayName: string;
  rrDelta: number | null;
  rankTierAfter: number | null;
  rankNameAfter: string | null;
  rrAfter: number | null;
}

// Ligne de stats persistee pour chaque match poste, base du recap hebdomadaire.
export interface MatchStatRecord {
  playerId: number;
  displayName: string;
  matchId: string;
  startedAt: string | null;
  didWin: boolean | null;
  rrDelta: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  headshots: number | null;
  bodyshots: number | null;
  legshots: number | null;
  score: number | null;
  roundsPlayed: number | null;
  damageDealt: number | null;
}

export interface LeaderboardEntry {
  playerId: number;
  displayName: string;
  rankTier: number | null;
  rankName: string | null;
  rankingInTier: number | null;
  wins: number | null;
  games: number | null;
  winRate: number | null;
}

export interface TrackerProvider {
  resolvePlayer(riotId: string, region: Region): Promise<ResolvedPlayer>;
  getPlayerSnapshot(player: PlayerIdentity): Promise<PlayerSnapshot>;
  getLatestCompetitiveMatch(player: PlayerIdentity): Promise<MatchSummary | null>;
  getRecentCompetitiveMatches(player: PlayerIdentity, limit: number): Promise<MatchSummary[]>;
  getMatchRrChanges(player: PlayerIdentity): Promise<Map<string, MatchRrChange>>;
}

export interface DiscordWebhookClient {
  postMessage(payload: DiscordWebhookPayload): Promise<void>;
  checkConnection(): Promise<void>;
}

export interface DiscordWebhookPayload {
  content?: string;
  embeds?: Array<Record<string, unknown>>;
}
