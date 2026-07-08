import { formatLeaderboard, formatMatchSummary, formatRankChange, formatStreak } from "./format.js";
import { buildWeeklyRecapPayload } from "./recap.js";
import type {
  DiscordWebhookClient,
  DiscordWebhookPayload,
  MatchRrChange,
  MatchSummary,
  MatchSummaryPost,
  PlayerIdentity,
  PlayerSnapshot,
  Region,
  TrackerProvider
} from "./types.js";
import { TrackerStore } from "./db.js";

export class TrackerService {
  // 5 matchs par joueur suffisent entre deux polls (15 min) et divisent par deux le cout
  // API : le quota HenrikDev Basic (30 req/min) est facture proportionnellement au nombre
  // de matchs recuperes.
  private static readonly MATCH_SCAN_LIMIT = 5;

  // L'historique MMR de chaque joueur se met a jour a son propre rythme cote HenrikDev :
  // un match commun peut etre detecte pour un joueur un poll avant l'autre. On differe la
  // publication tant qu'un joueur suivi present dans le lobby n'a pas encore le match,
  // dans la limite de cette fenetre (sinon on publie sans lui pour ne pas bloquer).
  private static readonly GROUP_WAIT_MAX_MS = 2 * 60 * 60 * 1000;

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
      const record = state.wins !== null && state.games !== null && state.games > 0
        ? ` - ${state.wins}V/${state.games - state.wins}D`
        : "";
      lines.push(`${label} [${player.region}] - ${rank}${record}`);
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
    for (const payload of formatLeaderboard(entries)) {
      await this.webhook.postMessage(payload);
    }

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

    const identity = playerToIdentity(latestCandidate.player);
    const state = await this.store.getPlayerState(latestCandidate.player.id);
    const snapshot = await this.provider.getPlayerSnapshot(identity);
    const rrChanges = await this.getMatchRrChangesSafely(identity, failures);
    const post = buildMatchPost(
      latestCandidate.player.displayName ?? `${latestCandidate.player.gameName}#${latestCandidate.player.tagLine}`,
      latestCandidate.match,
      rrChanges.get(latestCandidate.match.matchId) ?? null,
      state,
      snapshot
    );

    await this.webhook.postMessage(formatMatchSummary([post]));
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

    interface PendingPost {
      playerId: number;
      post: MatchSummaryPost;
      startedAt: string | null;
    }

    const pendingByMatch = new Map<string, PendingPost[]>();
    const playerCompletion = new Map<number, {
      displayName: string;
      // null = ne pas avancer le curseur (des matchs detectes ne sont pas encore visibles)
      latestMatchId: string | null;
      snapshotAfter: PlayerSnapshot;
      remainingMatchIds: Set<string>;
      announcements: DiscordWebhookPayload[];
    }>();

    // Phase 1 : collecter les matchs a poster de chaque joueur, sans encore rien envoyer,
    // pour pouvoir regrouper les joueurs suivis qui ont joue le meme match.
    // La detection passe par l'historique MMR (1 requete par joueur) : les details complets
    // des matchs ne sont telecharges que quand un nouveau match est detecte, ce qui permet
    // un polling frequent sans exploser le rate limit HenrikDev.
    for (const player of players) {
      checkedPlayers += 1;
      try {
        const identity = playerToIdentity(player);
        const stateBefore = await this.store.getPlayerState(player.id);
        const rrChanges = await this.provider.getMatchRrChanges(identity);
        const historyNewestFirst = [...rrChanges.values()].sort(
          (left, right) => compareMatchDates(right.startedAt, left.startedAt)
        );

        if (historyNewestFirst.length === 0) {
          continue;
        }

        const latestKnown = historyNewestFirst[0]!;
        const candidates = getMatchesNewerThanLastProcessed(historyNewestFirst, stateBefore.lastProcessedMatchId);
        if (candidates.length === 0) {
          await this.store.markMatchPosted(player.id, latestKnown.matchId);
          continue;
        }

        const postedMatchIds = await this.store.getPostedMatchIds(player.id, candidates.map((entry) => entry.matchId));
        const idsToPost = new Set(
          candidates.filter((entry) => !postedMatchIds.has(entry.matchId)).map((entry) => entry.matchId)
        );
        if (idsToPost.size === 0) {
          await this.store.updateLastProcessedMatchId(player.id, latestKnown.matchId);
          continue;
        }

        // Nouveaux matchs detectes : maintenant seulement on paye les details et le snapshot.
        const recentMatches = await this.provider.getRecentCompetitiveMatches(identity, TrackerService.MATCH_SCAN_LIMIT);
        const snapshotAfter = await this.provider.getPlayerSnapshot(identity);
        const matchesToPost = recentMatches
          .filter((match) => idsToPost.has(match.matchId))
          .sort(compareMatchDatesAscending);

        if (matchesToPost.length === 0) {
          // Matchs presents dans l'historique MMR mais pas encore dans le endpoint matches.
          // Si c'est recent c'est un simple decalage de donnees : on retentera au prochain
          // poll. Sinon les matchs sont sortis de la fenetre : on avance pour ne pas boucler.
          const newestCandidateTime = candidates[0]?.startedAt ? Date.parse(candidates[0].startedAt) : Number.NaN;
          if (!Number.isFinite(newestCandidateTime) || Date.now() - newestCandidateTime > 2 * 60 * 60 * 1000) {
            await this.store.updateLastProcessedMatchId(player.id, latestKnown.matchId);
          }
          continue;
        }

        // On n'avance le curseur que si tous les nouveaux matchs detectes sont visibles ;
        // sinon le prochain poll retentera (la dedupe posted_matches evite les doublons).
        const allCandidatesVisible = matchesToPost.length === idsToPost.size;
        const displayName = player.displayName ?? `${player.gameName}#${player.tagLine}`;
        const latestVisibleMatchId = recentMatches[0]?.matchId ?? latestKnown.matchId;

        for (const match of matchesToPost) {
          const rrChange = rrChanges.get(match.matchId) ?? null;
          const post = match.matchId === latestKnown.matchId
            ? buildMatchPost(displayName, match, rrChange, stateBefore, snapshotAfter)
            : buildMatchPost(displayName, match, rrChange, stateBefore, { ...snapshotAfter, lastRrChange: null }, { allowSnapshotFallback: false });

          const pending = pendingByMatch.get(match.matchId) ?? [];
          pending.push({ playerId: player.id, post, startedAt: match.startedAt });
          pendingByMatch.set(match.matchId, pending);
        }

        // Annonces post-match : serie en cours et changement de rang.
        const announcements: DiscordWebhookPayload[] = [];
        if (matchesToPost.some((match) => match.matchId === latestVisibleMatchId)) {
          const streak = computeStreak(recentMatches, TrackerService.MATCH_SCAN_LIMIT);
          if (streak) {
            announcements.push(formatStreak(displayName, streak.kind, streak.count, streak.isOpenEnded));
          }
        }
        if (
          snapshotAfter.rankTier !== null
          && snapshotAfter.rankName !== null
          && snapshotAfter.rankTier !== stateBefore.rankTier
        ) {
          announcements.push(formatRankChange(displayName, stateBefore, {
            rankTier: snapshotAfter.rankTier,
            rankName: snapshotAfter.rankName
          }));
        }

        playerCompletion.set(player.id, {
          displayName,
          latestMatchId: allCandidatesVisible ? latestKnown.matchId : null,
          snapshotAfter,
          remainingMatchIds: new Set(matchesToPost.map((match) => match.matchId)),
          announcements
        });
      } catch (error) {
        failures.push(`${player.displayName ?? `${player.gameName}#${player.tagLine}`}: ${formatError(error)}`);
      }
    }

    // Phase 2 : poster un message par match, du plus ancien au plus recent.
    const groups = [...pendingByMatch.entries()].sort(
      (left, right) => compareMatchDates(left[1][0]!.startedAt, right[1][0]!.startedAt)
    );

    // Joueurs dont un match a ete differe : leurs matchs suivants sont aussi differes
    // pour conserver l'ordre chronologique de leurs publications.
    const deferredPlayerIds = new Set<number>();

    for (const [matchId, pending] of groups) {
      if (pending.some((entry) => deferredPlayerIds.has(entry.playerId))) {
        for (const entry of pending) {
          deferredPlayerIds.add(entry.playerId);
        }
        continue;
      }

      if (await this.shouldWaitForTrackedTeammates(matchId, pending, players)) {
        for (const entry of pending) {
          deferredPlayerIds.add(entry.playerId);
        }
        continue;
      }

      try {
        await this.webhook.postMessage(formatMatchSummary(pending.map((entry) => entry.post)));
        for (const entry of pending) {
          await this.store.markMatchPosted(entry.playerId, matchId);
          await this.store.recordMatchStats(entry.playerId, entry.post);
          playerCompletion.get(entry.playerId)?.remainingMatchIds.delete(matchId);
        }
        postedMatches += 1;
      } catch (error) {
        failures.push(`Match sur ${pending[0]!.post.mapName}: ${formatError(error)}`);
        // On s'arrete pour garder l'ordre chronologique ; le prochain poll reessaiera.
        break;
      }
    }

    // Phase 3 : n'avancer le curseur d'un joueur que si tous ses matchs en attente sont partis,
    // puis poster ses annonces (serie, changement de rang).
    for (const [playerId, completion] of playerCompletion) {
      if (completion.remainingMatchIds.size > 0) {
        continue;
      }

      try {
        await this.store.updatePlayerSnapshot(playerId, completion.snapshotAfter, {
          lastProcessedMatchId: completion.latestMatchId
        });
      } catch (error) {
        failures.push(`Mise a jour du snapshot du joueur ${playerId}: ${formatError(error)}`);
      }

      for (const announcement of completion.announcements) {
        try {
          await this.webhook.postMessage(announcement);
        } catch (error) {
          failures.push(`Annonce pour ${completion.displayName}: ${formatError(error)}`);
        }
      }
    }

    return { checkedPlayers, postedMatches, failures };
  }

  public async postWeeklyRecap(): Promise<{ posted: boolean; failures: string[] }> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const records = await this.store.getMatchStatsSince(since);
    await this.webhook.postMessage(buildWeeklyRecapPayload(records));
    return { posted: true, failures: [] };
  }

  // Vrai si un autre joueur suivi figure dans le lobby du match, ne l'a pas encore poste,
  // et que le match est assez recent pour esperer le voir apparaitre au prochain poll.
  private async shouldWaitForTrackedTeammates(
    matchId: string,
    pending: Array<{ playerId: number; post: MatchSummaryPost; startedAt: string | null }>,
    players: Array<{ id: number; puuid: string }>
  ): Promise<boolean> {
    const startedAtTime = pending[0]?.startedAt ? Date.parse(pending[0].startedAt) : Number.NaN;
    if (!Number.isFinite(startedAtTime) || Date.now() - startedAtTime > TrackerService.GROUP_WAIT_MAX_MS) {
      return false;
    }

    const pendingPlayerIds = new Set(pending.map((entry) => entry.playerId));
    const rosterPuuids = new Set(pending[0]!.post.rosterPuuids);
    const missingPlayers = players.filter(
      (player) => !pendingPlayerIds.has(player.id) && rosterPuuids.has(player.puuid)
    );

    for (const player of missingPlayers) {
      const alreadyPosted = await this.store.getPostedMatchIds(player.id, [matchId]);
      if (!alreadyPosted.has(matchId)) {
        return true;
      }
    }

    return false;
  }

  private async getMatchRrChangesSafely(identity: PlayerIdentity, failures: string[]): Promise<Map<string, MatchRrChange>> {
    try {
      return await this.provider.getMatchRrChanges(identity);
    } catch (error) {
      failures.push(`${identity.gameName}#${identity.tagLine} (historique RR): ${formatError(error)}`);
      return new Map();
    }
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
  match: MatchSummary,
  rrChange: MatchRrChange | null,
  snapshotBefore: {
    rankName: string | null;
    rankTier: number | null;
    rankingInTier: number | null;
  },
  snapshotAfter: PlayerSnapshot,
  options: {
    allowSnapshotFallback?: boolean;
  } = {}
): MatchSummaryPost {
  const allowSnapshotFallback = options.allowSnapshotFallback !== false;
  const fallbackRrDelta = allowSnapshotFallback
    && snapshotBefore.rankTier !== null
    && snapshotAfter.rankTier !== null
    && snapshotBefore.rankTier === snapshotAfter.rankTier
    && snapshotBefore.rankingInTier !== null
    && snapshotAfter.rankingInTier !== null
    ? snapshotAfter.rankingInTier - snapshotBefore.rankingInTier
    : null;

  // L'historique MMR fait foi : il donne le delta RR exact du match. Le snapshot
  // MMR courant ne sert de secours que pour le match le plus recent.
  return {
    ...match,
    playerDisplayName: displayName,
    rrDelta: rrChange?.rrChange ?? snapshotAfter.lastRrChange ?? fallbackRrDelta,
    rankTierAfter: rrChange?.rankTierAfter ?? (allowSnapshotFallback ? snapshotAfter.rankTier : null),
    rankNameAfter: rrChange?.rankNameAfter ?? (allowSnapshotFallback ? snapshotAfter.rankName : null),
    rrAfter: rrChange?.rrAfter ?? (allowSnapshotFallback ? snapshotAfter.rankingInTier : null)
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Serie en cours : au moins 3 resultats identiques consecutifs en partant du match le plus recent.
// isOpenEnded = la serie remplit toute la fenetre demandee, elle est donc peut-etre plus longue.
function computeStreak(matchesNewestFirst: Array<{ didWin: boolean | null }>, scanLimit: number): {
  kind: "win" | "loss";
  count: number;
  isOpenEnded: boolean;
} | null {
  const latest = matchesNewestFirst[0];
  if (!latest || latest.didWin === null) {
    return null;
  }

  let count = 0;
  for (const match of matchesNewestFirst) {
    if (match.didWin !== latest.didWin) {
      break;
    }
    count += 1;
  }

  if (count < 3) {
    return null;
  }

  return {
    kind: latest.didWin ? "win" : "loss",
    count,
    isOpenEnded: count === matchesNewestFirst.length && matchesNewestFirst.length >= scanLimit
  };
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
