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
  private static readonly MATCH_SCAN_LIMIT = 10;

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
    const recentMatches = await this.provider.getRecentCompetitiveMatches(identity, TrackerService.MATCH_SCAN_LIMIT);
    const latestMatch = recentMatches[0] ?? null;

    await this.store.updatePlayerSnapshot(player.id, snapshot, {
      lastProcessedMatchId: latestMatch?.matchId ?? null
    });
    await this.store.markMatchesPosted(player.id, recentMatches.map((match) => match.matchId));
  }

  public async removePlayer(riotId: string, region: Region): Promise<boolean> {
    const [gameName, tagLine, ...rest] = riotId.split("#");
    if (!gameName || !tagLine || rest.length > 0) {
      throw new Error(`Riot ID invalide "${riotId}". Format attendu : "<nom>#<tag>"`);
    }

    return this.store.removeTrackedPlayer(gameName, tagLine, region);
  }

  public async renamePlayer(riotId: string, region: Region, displayName: string | null): Promise<boolean> {
    const [gameName, tagLine, ...rest] = riotId.split("#");
    if (!gameName || !tagLine || rest.length > 0) {
      throw new Error(`Riot ID invalide "${riotId}". Format attendu : "<nom>#<tag>"`);
    }

    return this.store.renameTrackedPlayer(gameName, tagLine, region, displayName);
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

  public async checkHealth(): Promise<{ checkedPlayers: number; failures: string[] }> {
    const failures: string[] = [];
    const players = await this.store.listTrackedPlayers();

    try {
      await this.webhook.checkConnection();
    } catch (error) {
      failures.push(`Discord webhook: ${formatError(error)}`);
    }

    if (players.length > 0) {
      const player = players[0]!;
      try {
        const identity = playerToIdentity(player);
        await this.provider.getPlayerSnapshot(identity);
        await this.provider.getRecentCompetitiveMatches(identity, 1);
      } catch (error) {
        failures.push(`${player.displayName ?? `${player.gameName}#${player.tagLine}`}: ${formatError(error)}`);
      }
    }

    return {
      checkedPlayers: players.length,
      failures
    };
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
        const recentMatches = await this.provider.getRecentCompetitiveMatches(identity, TrackerService.MATCH_SCAN_LIMIT);

        if (recentMatches.length === 0) {
          continue;
        }

        const latestMatch = recentMatches[0]!;
        const candidateMatches = getMatchesNewerThanLastProcessed(recentMatches, stateBefore.lastProcessedMatchId);
        if (candidateMatches.length === 0) {
          await this.store.markMatchPosted(player.id, latestMatch.matchId);
          continue;
        }

        const postedMatchIds = await this.store.getPostedMatchIds(player.id, candidateMatches.map((match) => match.matchId));
        const matchesToPost = candidateMatches
          .filter((match) => !postedMatchIds.has(match.matchId))
          .sort(compareMatchDatesAscending);

        if (matchesToPost.length === 0) {
          await this.store.updateLastProcessedMatchId(player.id, latestMatch.matchId);
          continue;
        }

        const snapshotAfter = await this.provider.getPlayerSnapshot(identity);
        const displayName = player.displayName ?? `${player.gameName}#${player.tagLine}`;

        for (const match of matchesToPost) {
          const post = match.matchId === latestMatch.matchId
            ? buildMatchPost(displayName, match, stateBefore, snapshotAfter)
            : buildMatchPost(displayName, match, stateBefore, { ...snapshotAfter, lastRrChange: null }, { allowFallbackRrDelta: false });

          await this.webhook.postMessage(formatMatchSummary(post));
          await this.store.markMatchPosted(player.id, match.matchId);
          postedMatches += 1;
        }

        await this.store.updatePlayerSnapshot(player.id, snapshotAfter, {
          lastProcessedMatchId: latestMatch.matchId
        });
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
    rankTier: number | null;
    rankingInTier: number | null;
  },
  snapshotAfter: PlayerSnapshot,
  options: {
    allowFallbackRrDelta?: boolean;
  } = {}
): MatchSummaryPost {
  const fallbackRrDelta = options.allowFallbackRrDelta !== false
    && snapshotBefore.rankTier !== null
    && snapshotAfter.rankTier !== null
    && snapshotBefore.rankTier === snapshotAfter.rankTier
    && snapshotBefore.rankingInTier !== null
    && snapshotAfter.rankingInTier !== null
    ? snapshotAfter.rankingInTier - snapshotBefore.rankingInTier
    : null;

  return {
    ...match,
    playerDisplayName: displayName,
    rrDelta: snapshotAfter.lastRrChange ?? fallbackRrDelta
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

function compareMatchDatesAscending(left: { startedAt: string | null }, right: { startedAt: string | null }): number {
  const delta = compareMatchDates(left.startedAt, right.startedAt);
  return delta !== 0 ? delta : 0;
}

function getMatchesNewerThanLastProcessed<T extends { matchId: string }>(matchesNewestFirst: T[], lastProcessedMatchId: string | null): T[] {
  if (lastProcessedMatchId === null) {
    return matchesNewestFirst;
  }

  const lastProcessedIndex = matchesNewestFirst.findIndex((match) => match.matchId === lastProcessedMatchId);
  if (lastProcessedIndex === -1) {
    return matchesNewestFirst;
  }

  return matchesNewestFirst.slice(0, lastProcessedIndex);
}
