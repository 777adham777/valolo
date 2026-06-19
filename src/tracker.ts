import { formatLeaderboard, formatMatchSummary } from "./format.js";
import type {
  DiscordWebhookClient,
  LeaderboardEntry,
  MatchSummaryPost,
  PlayerIdentity,
  PlayerSnapshot,
  Region,
  TrackerProvider
} from "./types.js";
import { TrackerStore } from "./db.js";

export class TrackerService {
  public constructor(
    private readonly store: TrackerStore,
    private readonly provider: TrackerProvider,
    private readonly webhook: DiscordWebhookClient
  ) {}

  public async addPlayer(riotId: string, region: Region, displayName: string | null = null): Promise<void> {
    const resolved = await this.provider.resolvePlayer(riotId, region);
    const player = await this.store.addTrackedPlayer({
      gameName: resolved.gameName,
      tagLine: resolved.tagLine,
      region: resolved.region,
      puuid: resolved.puuid,
      displayName: displayName ?? resolved.displayName
    });

    const identity = playerToIdentity(player);
    const snapshot = await this.provider.getPlayerSnapshot(identity);
    const latestMatch = await this.provider.getLatestCompetitiveMatch(identity);

    await this.store.updatePlayerSnapshot(player.id, snapshot, {
      lastProcessedMatchId: latestMatch?.matchId ?? null
    });
  }

  public async removePlayer(riotId: string, region: Region): Promise<boolean> {
    const [gameName, tagLine] = riotId.split("#");
    if (!gameName || !tagLine) {
      throw new Error(`Riot ID invalide "${riotId}". Format attendu : "<nom>#<tag>"`);
    }

    return this.store.removeTrackedPlayer(gameName, tagLine, region);
  }

  public async listPlayers(): Promise<string[]> {
    const players = await this.store.listTrackedPlayers();
    const lines: string[] = [];

    for (const player of players) {
      const state = await this.store.getPlayerState(player.id);
      const label = player.displayName ?? `${player.gameName}#${player.tagLine}`;
      const rank = state.rankName ? `${state.rankName}${state.rankingInTier !== null ? ` (${state.rankingInTier} RR)` : ""}` : "Non classe";
      lines.push(`${label} [${player.region}] - ${rank}`);
    }

    return lines;
  }

  public async syncSnapshots(): Promise<{ updatedPlayers: number; failures: string[] }> {
    const players = await this.store.listTrackedPlayers();
    const failures: string[] = [];
    let updatedPlayers = 0;

    for (const player of players) {
      try {
        const snapshot = await this.provider.getPlayerSnapshot(playerToIdentity(player));
        await this.store.updatePlayerSnapshot(player.id, snapshot);
        updatedPlayers += 1;
      } catch (error) {
        failures.push(`${player.displayName ?? `${player.gameName}#${player.tagLine}`}: ${formatError(error)}`);
      }
    }

    return { updatedPlayers, failures };
  }

  public async postDailyLeaderboard(): Promise<{ posted: boolean; failures: string[] }> {
    const syncResult = await this.syncSnapshots();
    const entries = await this.store.getLeaderboardEntries();
    await this.webhook.postMessage(formatLeaderboard(entries));

    return {
      posted: true,
      failures: syncResult.failures
    };
  }

  public async postLatestTrackedMatch(): Promise<{
    posted: boolean;
    failures: string[];
  }> {
    const players = await this.store.listTrackedPlayers();
    const failures: string[] = [];
    let latestCandidate: {
      player: Awaited<ReturnType<TrackerStore["listTrackedPlayers"]>>[number];
      match: Awaited<ReturnType<TrackerProvider["getLatestCompetitiveMatch"]>>;
    } | null = null;

    for (const player of players) {
      try {
        const match = await this.provider.getLatestCompetitiveMatch(playerToIdentity(player));
        if (!match) {
          continue;
        }

        if (!latestCandidate || compareMatchDates(match.startedAt, latestCandidate.match?.startedAt ?? null) > 0) {
          latestCandidate = { player, match };
        }
      } catch (error) {
        failures.push(`${player.displayName ?? `${player.gameName}#${player.tagLine}`}: ${formatError(error)}`);
      }
    }

    if (!latestCandidate || !latestCandidate.match) {
      return { posted: false, failures };
    }

    const state = await this.store.getPlayerState(latestCandidate.player.id);
    const snapshot = await this.provider.getPlayerSnapshot(playerToIdentity(latestCandidate.player));
    const post = buildMatchPost(
      latestCandidate.player.displayName ?? `${latestCandidate.player.gameName}#${latestCandidate.player.tagLine}`,
      latestCandidate.match,
      state,
      snapshot
    );

    await this.webhook.postMessage(formatMatchSummary(post));
    return { posted: true, failures };
  }

  public async pollMatches(): Promise<{
    checkedPlayers: number;
    postedMatches: number;
    failures: string[];
  }> {
    const players = await this.store.listTrackedPlayers();
    const failures: string[] = [];
    let checkedPlayers = 0;
    let postedMatches = 0;

    for (const player of players) {
      checkedPlayers += 1;
      try {
        const identity = playerToIdentity(player);
        const stateBefore = await this.store.getPlayerState(player.id);
        const latestMatch = await this.provider.getLatestCompetitiveMatch(identity);

        if (!latestMatch) {
          continue;
        }

        if (latestMatch.matchId === stateBefore.lastProcessedMatchId) {
          continue;
        }

        const snapshotAfter = await this.provider.getPlayerSnapshot(identity);
        const post = buildMatchPost(
          player.displayName ?? `${player.gameName}#${player.tagLine}`,
          latestMatch,
          stateBefore,
          snapshotAfter
        );

        await this.webhook.postMessage(formatMatchSummary(post));
        await this.store.updatePlayerSnapshot(player.id, snapshotAfter, {
          lastProcessedMatchId: latestMatch.matchId
        });
        postedMatches += 1;
      } catch (error) {
        failures.push(`${player.displayName ?? `${player.gameName}#${player.tagLine}`}: ${formatError(error)}`);
      }
    }

    return { checkedPlayers, postedMatches, failures };
  }
}

function playerToIdentity(player: {
  gameName: string;
  tagLine: string;
  region: Region;
  puuid: string;
}): PlayerIdentity {
  return {
    gameName: player.gameName,
    tagLine: player.tagLine,
    region: player.region,
    puuid: player.puuid
  };
}

function buildMatchPost(
  displayName: string,
  match: {
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
  },
  snapshotBefore: {
    rankName: string | null;
    rankingInTier: number | null;
  },
  snapshotAfter: PlayerSnapshot
): MatchSummaryPost {
  return {
    ...match,
    playerDisplayName: displayName,
    rrDelta:
      snapshotBefore.rankingInTier !== null && snapshotAfter.rankingInTier !== null
        ? snapshotAfter.rankingInTier - snapshotBefore.rankingInTier
        : null
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareMatchDates(left: string | null, right: string | null): number {
  const leftTime = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const rightTime = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return leftTime - rightTime;
}
