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
}

export interface MatchSummary {
  matchId: string;
  mode: string;
  mapName: string;
  startedAt: string | null;
  seasonShort: string | null;
  gameLengthInMs: number | null;
  agentName: string | null;
  agentPortraitUrl: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  score: number | null;
  teamScore: number | null;
  opponentScore: number | null;
  didWin: boolean | null;
}

export interface MatchSummaryPost extends MatchSummary {
  playerDisplayName: string;
  rrDelta: number | null;
}

export interface LeaderboardEntry {
  playerId: number;
  displayName: string;
  rankTier: number | null;
  rankName: string | null;
  rankingInTier: number | null;
}

export interface TrackerProvider {
  resolvePlayer(riotId: string, region: Region): Promise<ResolvedPlayer>;
  getPlayerSnapshot(player: PlayerIdentity): Promise<PlayerSnapshot>;
  getLatestCompetitiveMatch(player: PlayerIdentity): Promise<MatchSummary | null>;
  getRecentCompetitiveMatches(player: PlayerIdentity, limit: number): Promise<MatchSummary[]>;
}

export interface DiscordWebhookClient {
  postMessage(payload: DiscordWebhookPayload): Promise<void>;
  checkConnection(): Promise<void>;
}

export interface DiscordWebhookPayload {
  content?: string;
  embeds?: Array<Record<string, unknown>>;
}
