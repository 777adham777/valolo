import type {
  MatchRrChange,
  MatchSummary,
  PlayerIdentity,
  PlayerSnapshot,
  Region,
  ResolvedPlayer,
  TrackerProvider
} from "../types.js";

interface HenrikDevClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class HenrikDevProvider implements TrackerProvider {
  private static readonly MAX_MATCH_LIMIT = 10;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: HenrikDevClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? "https://api.henrikdev.xyz";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async resolvePlayer(riotId: string, region: Region): Promise<ResolvedPlayer> {
    const { gameName, tagLine } = parseRiotId(riotId);
    const response = await this.getJson(`/valorant/v1/account/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
    const data = expectObject(response.data, "account data");
    const puuid = expectString(data.puuid, "account.puuid");
    const canonicalGameName = expectString(data.name, "account.name");
    const canonicalTagLine = expectString(data.tag, "account.tag");

    return {
      gameName: canonicalGameName,
      tagLine: canonicalTagLine,
      region,
      puuid,
      displayName: `${canonicalGameName}#${canonicalTagLine}`
    };
  }

  public async getPlayerSnapshot(player: PlayerIdentity): Promise<PlayerSnapshot> {
    const response = await this.getJson(`/valorant/v3/by-puuid/mmr/${encodeURIComponent(player.region)}/pc/${encodeURIComponent(player.puuid)}`);
    const data = expectObject(response.data, "mmr data");
    const currentData = expectObject(data.current, "mmr current");
    const tier = expectObject(currentData.tier, "mmr current tier");
    const seasonStats = parseCurrentSeasonStats(data.seasonal);

    return {
      rankTier: readOptionalNumber(tier.id),
      rankName: readOptionalString(tier.name),
      rankingInTier: readOptionalNumber(currentData.rr),
      lastRrChange: readOptionalNumber(currentData.last_change),
      wins: seasonStats.wins,
      games: seasonStats.games
    };
  }

  public async getMatchRrChanges(player: PlayerIdentity): Promise<Map<string, MatchRrChange>> {
    const response = await this.getJson(
      `/valorant/v2/by-puuid/mmr-history/${encodeURIComponent(player.region)}/pc/${encodeURIComponent(player.puuid)}`
    );
    const data = expectObject(response.data, "mmr history data");
    const history = expectArray(data.history, "mmr history entries");
    const changes = new Map<string, MatchRrChange>();

    for (const entry of history) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const matchId = readOptionalString(record.match_id);
      if (!matchId) {
        continue;
      }

      const tier = record.tier && typeof record.tier === "object" && !Array.isArray(record.tier)
        ? record.tier as Record<string, unknown>
        : null;

      changes.set(matchId, {
        matchId,
        startedAt: readOptionalString(record.date),
        rrChange: readOptionalNumber(record.last_change),
        rrAfter: readOptionalNumber(record.rr),
        rankTierAfter: readOptionalNumber(tier?.id),
        rankNameAfter: readOptionalString(tier?.name)
      });
    }

    return changes;
  }

  public async getLatestCompetitiveMatch(player: PlayerIdentity): Promise<MatchSummary | null> {
    const matches = await this.getRecentCompetitiveMatches(player, 1);
    return matches[0] ?? null;
  }

  public async getRecentCompetitiveMatches(
    player: PlayerIdentity,
    limit: number
  ): Promise<MatchSummary[]> {
    const size = Math.max(1, Math.min(Math.floor(limit), HenrikDevProvider.MAX_MATCH_LIMIT));
    const response = await this.getJson(
      `/valorant/v4/by-puuid/matches/${encodeURIComponent(player.region)}/pc/${encodeURIComponent(player.puuid)}?mode=competitive&size=${size}`
    );

    const matches = expectArray(response.data, "matches");
    return matches
      .filter((match): match is Record<string, unknown> => Boolean(match) && typeof match === "object")
      .map((match) => parseMatchSummary(match, player.puuid));
  }

  private async getJson(path: string): Promise<Record<string, unknown>> {
    const response = await withRetry(async () => this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: this.apiKey,
        Accept: "application/json"
      }
    }));

    if (!response.ok) {
      const body = await response.text();
      const retryAfter = response.headers.get("retry-after");
      const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
      const rateLimitReset = response.headers.get("x-ratelimit-reset");
      const details = [
        retryAfter ? `retry-after=${retryAfter}` : null,
        rateLimitRemaining ? `x-ratelimit-remaining=${rateLimitRemaining}` : null,
        rateLimitReset ? `x-ratelimit-reset=${rateLimitReset}` : null
      ].filter(Boolean).join(", ");
      throw new Error(`HenrikDev request failed with ${response.status}${details ? ` (${details})` : ""}: ${body}`);
    }

    const data = await response.json() as unknown;
    if (!data || typeof data !== "object") {
      throw new Error("HenrikDev response was not an object");
    }

    return data as Record<string, unknown>;
  }
}

async function withRetry(request: () => Promise<Response>, attempts = 3): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await request();
    if (!shouldRetry(response) || attempt === attempts) {
      return response;
    }

    lastResponse = response;
    await delay(getRetryDelayInMs(response, attempt));
  }

  return lastResponse ?? request();
}

function shouldRetry(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

// Le quota HenrikDev se recharge par fenetre d'une minute : sur un 429 il faut
// attendre le vrai delai annonce par l'API, sinon les retries partent trop tot
// et se consument pour rien.
const MAX_RETRY_DELAY_IN_MS = 70_000;

function getRetryDelayInMs(response: Response, attempt: number): number {
  const waitHint = readDelayHeaderInSeconds(response, "retry-after")
    ?? (response.status === 429 ? readDelayHeaderInSeconds(response, "x-ratelimit-reset") : null);
  if (waitHint !== null) {
    // +1s de marge pour etre sur que la fenetre de quota est bien reinitialisee.
    return Math.min((waitHint + 1) * 1000, MAX_RETRY_DELAY_IN_MS);
  }

  return 500 * attempt;
}

function readDelayHeaderInSeconds(response: Response, header: string): number | null {
  const raw = response.headers.get(header);
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRiotId(riotId: string): { gameName: string; tagLine: string } {
  const [gameName, tagLine, ...rest] = riotId.split("#");
  if (!gameName || !tagLine || rest.length > 0) {
    throw new Error(`Invalid Riot ID "${riotId}". Expected "<name>#<tag>"`);
  }

  return { gameName, tagLine };
}

const DUELIST_AGENT_NAMES = new Set([
  "jett",
  "phoenix",
  "reyna",
  "raze",
  "yoru",
  "neon",
  "iso",
  "waylay"
]);

function parseMatchSummary(match: Record<string, unknown>, puuid: string): MatchSummary {
  const metadata = expectObject(match.metadata, "match metadata");
  const players = expectArray(match.players, "match players");
  const teams = expectArray(match.teams, "match teams");

  const playerEntry = players.find((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    return (entry as Record<string, unknown>).puuid === puuid;
  }) as Record<string, unknown> | undefined;

  if (!playerEntry) {
    throw new Error(`Tracked player ${puuid} was not present in competitive match payload`);
  }

  const teamId = readOptionalString(playerEntry.team_id);
  const teamEntry = teams.find((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    return readOptionalString((entry as Record<string, unknown>).team_id) === teamId;
  }) as Record<string, unknown> | undefined;

  const opponentEntry = teams.find((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    return readOptionalString((entry as Record<string, unknown>).team_id) !== teamId;
  }) as Record<string, unknown> | undefined;

  const stats = expectObject(playerEntry.stats, "player stats");
  const rounds = teamEntry && typeof teamEntry.rounds === "object" && teamEntry.rounds !== null
    ? expectObject(teamEntry.rounds, "team rounds")
    : null;
  const opponentRounds = opponentEntry && typeof opponentEntry.rounds === "object" && opponentEntry.rounds !== null
    ? expectObject(opponentEntry.rounds, "opponent rounds")
    : null;
  const queue = metadata.queue && typeof metadata.queue === "object"
    ? expectObject(metadata.queue, "queue")
    : null;
  const map = metadata.map && typeof metadata.map === "object"
    ? expectObject(metadata.map, "map")
    : null;
  const agent = playerEntry.agent && typeof playerEntry.agent === "object"
    ? expectObject(playerEntry.agent, "agent")
    : null;
  const season = metadata.season && typeof metadata.season === "object"
    ? expectObject(metadata.season, "season")
    : null;
  const damage = stats.damage && typeof stats.damage === "object" && !Array.isArray(stats.damage)
    ? stats.damage as Record<string, unknown>
    : null;

  const teamScore = readOptionalNumber(rounds?.won);
  const opponentScore = readOptionalNumber(opponentRounds?.won);
  const didWin = typeof teamEntry?.won === "boolean" ? teamEntry.won : null;
  const matchRounds = Array.isArray(match.rounds) ? match.rounds : null;
  const roundsPlayed = matchRounds && matchRounds.length > 0
    ? matchRounds.length
    : teamScore !== null && opponentScore !== null
      ? teamScore + opponentScore
      : null;
  const agentName = readOptionalString(agent?.name);

  return {
    matchId: expectString(metadata.match_id, "match metadata.match_id"),
    mode: readOptionalString(queue?.name) ?? "Competitive",
    mapName: readOptionalString(map?.name) ?? "Carte inconnue",
    mapImageUrl: buildMapSplashUrl(readOptionalString(map?.id)),
    startedAt: readOptionalString(metadata.started_at),
    seasonShort: readOptionalString(season?.short),
    gameLengthInMs: readOptionalNumber(metadata.game_length_in_ms),
    agentName,
    agentPortraitUrl: buildAgentPortraitUrl(readOptionalString(agent?.id)),
    teamId,
    kills: readOptionalNumber(stats.kills),
    deaths: readOptionalNumber(stats.deaths),
    assists: readOptionalNumber(stats.assists),
    headshots: readOptionalNumber(stats.headshots),
    bodyshots: readOptionalNumber(stats.bodyshots),
    legshots: readOptionalNumber(stats.legshots),
    score: readOptionalNumber(stats.score),
    damageDealt: readOptionalNumber(damage?.dealt),
    roundsPlayed,
    teamScore,
    opponentScore,
    didWin,
    highlights: computeHighlights(match, players, playerEntry, puuid, teamId, agentName, didWin)
  };
}

interface LobbyPlayerStats {
  puuid: string;
  teamId: string | null;
  kills: number | null;
  deaths: number | null;
  score: number | null;
}

function computeHighlights(
  match: Record<string, unknown>,
  players: unknown[],
  playerEntry: Record<string, unknown>,
  puuid: string,
  teamId: string | null,
  agentName: string | null,
  didWin: boolean | null
): MatchSummary["highlights"] {
  const lobby: LobbyPlayerStats[] = players
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => {
      const entryStats = entry.stats && typeof entry.stats === "object" && !Array.isArray(entry.stats)
        ? entry.stats as Record<string, unknown>
        : null;
      return {
        puuid: readOptionalString(entry.puuid) ?? "",
        teamId: readOptionalString(entry.team_id),
        kills: readOptionalNumber(entryStats?.kills),
        deaths: readOptionalNumber(entryStats?.deaths),
        score: readOptionalNumber(entryStats?.score)
      };
    })
    .filter((entry) => entry.puuid.length > 0);

  const self = lobby.find((entry) => entry.puuid === puuid) ?? null;
  const others = lobby.filter((entry) => entry.puuid !== puuid);
  const teammates = others.filter((entry) => teamId !== null && entry.teamId === teamId);

  const killEvents = parseKillEvents(match.kills);
  const firstEngagements = getFirstEngagementsByRound(killEvents);
  const firstDeathCounts = new Map<string, number>();
  let firstBloods: number | null = null;
  let firstDeaths: number | null = null;
  if (firstEngagements !== null) {
    firstBloods = 0;
    firstDeaths = 0;
    for (const engagement of firstEngagements.values()) {
      if (engagement.killerPuuid === puuid) {
        firstBloods += 1;
      }
      if (engagement.victimPuuid) {
        firstDeathCounts.set(engagement.victimPuuid, (firstDeathCounts.get(engagement.victimPuuid) ?? 0) + 1);
      }
    }
    firstDeaths = firstDeathCounts.get(puuid) ?? 0;
  }

  const selfKills = self?.kills ?? null;
  const selfDeaths = self?.deaths ?? null;
  const selfScore = self?.score ?? null;
  const scoreSwing = detectScoreSwing(match.rounds, teamId);

  return {
    aces: countAces(killEvents, puuid),
    firstBloods,
    firstDeaths,
    isMostFirstDeathsInMatch: firstDeaths !== null && firstDeaths > 0
      && isUniqueMax(firstDeaths, others.map((entry) => firstDeathCounts.get(entry.puuid) ?? 0)),
    isMostDeathsInMatch: selfDeaths !== null && others.length > 0
      && isUniqueMax(selfDeaths, others.map((entry) => entry.deaths ?? 0)),
    isBottomFragOfMatch: selfKills !== null && others.length > 0
      && others.every((entry) => entry.kills !== null && entry.kills > selfKills),
    isTopScoreOfMatch: selfScore !== null && others.length > 0
      && isUniqueMax(selfScore, others.map((entry) => entry.score ?? 0)),
    isInBottomThreeOfLobby: selfScore !== null && lobby.length >= 8
      && others.filter((entry) => entry.score !== null && entry.score < selfScore).length <= 2,
    teamCarryRatio: computeTeamCarryRatio(self, teammates),
    isDuelist: agentName !== null && DUELIST_AGENT_NAMES.has(agentName.toLowerCase()),
    teamChoked: didWin === false && scoreSwing.teamHadBigLead,
    teamComeback: didWin === true && scoreSwing.opponentHadBigLead
  };
}

interface KillEvent {
  round: number;
  timeInRoundInMs: number;
  killerPuuid: string | null;
  victimPuuid: string | null;
}

function parseKillEvents(kills: unknown): KillEvent[] | null {
  if (!Array.isArray(kills)) {
    return null;
  }

  const events: KillEvent[] = [];
  for (const entry of kills) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const round = readOptionalNumber(record.round);
    if (round === null) {
      continue;
    }

    const killer = record.killer && typeof record.killer === "object" && !Array.isArray(record.killer)
      ? record.killer as Record<string, unknown>
      : null;
    const victim = record.victim && typeof record.victim === "object" && !Array.isArray(record.victim)
      ? record.victim as Record<string, unknown>
      : null;

    events.push({
      round,
      timeInRoundInMs: readOptionalNumber(record.time_in_round_in_ms) ?? Number.MAX_SAFE_INTEGER,
      killerPuuid: readOptionalString(killer?.puuid),
      victimPuuid: readOptionalString(victim?.puuid)
    });
  }

  return events;
}

function getFirstEngagementsByRound(
  killEvents: KillEvent[] | null
): Map<number, { killerPuuid: string | null; victimPuuid: string | null }> | null {
  if (killEvents === null || killEvents.length === 0) {
    return killEvents === null ? null : new Map();
  }

  const firstByRound = new Map<number, KillEvent>();
  for (const event of killEvents) {
    const current = firstByRound.get(event.round);
    if (!current || event.timeInRoundInMs < current.timeInRoundInMs) {
      firstByRound.set(event.round, event);
    }
  }

  const result = new Map<number, { killerPuuid: string | null; victimPuuid: string | null }>();
  for (const [round, event] of firstByRound) {
    result.set(round, { killerPuuid: event.killerPuuid, victimPuuid: event.victimPuuid });
  }

  return result;
}

function countAces(killEvents: KillEvent[] | null, puuid: string): number {
  if (killEvents === null) {
    return 0;
  }

  const killsByRound = new Map<number, number>();
  for (const event of killEvents) {
    if (event.killerPuuid === puuid) {
      killsByRound.set(event.round, (killsByRound.get(event.round) ?? 0) + 1);
    }
  }

  let aces = 0;
  for (const kills of killsByRound.values()) {
    if (kills >= 5) {
      aces += 1;
    }
  }

  return aces;
}

// "Big lead" : au moins 9 rounds gagnes avec 6 rounds d'avance (ex. 11-2). Mene avec un tel
// ecart puis perdre = choke ; le retourner en gagnant = remontada.
function detectScoreSwing(rounds: unknown, teamId: string | null): {
  teamHadBigLead: boolean;
  opponentHadBigLead: boolean;
} {
  if (!Array.isArray(rounds) || teamId === null) {
    return { teamHadBigLead: false, opponentHadBigLead: false };
  }

  let teamWins = 0;
  let opponentWins = 0;
  let teamHadBigLead = false;
  let opponentHadBigLead = false;

  for (const entry of rounds) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const winningTeam = readOptionalString((entry as Record<string, unknown>).winning_team);
    if (winningTeam === null) {
      continue;
    }

    if (winningTeam === teamId) {
      teamWins += 1;
    } else {
      opponentWins += 1;
    }

    if (teamWins >= 9 && teamWins - opponentWins >= 6) {
      teamHadBigLead = true;
    }
    if (opponentWins >= 9 && opponentWins - teamWins >= 6) {
      opponentHadBigLead = true;
    }
  }

  return { teamHadBigLead, opponentHadBigLead };
}

function computeTeamCarryRatio(self: LobbyPlayerStats | null, teammates: LobbyPlayerStats[]): number | null {
  if (!self || self.score === null || teammates.length === 0) {
    return null;
  }

  const bestTeammateScore = Math.max(...teammates.map((entry) => entry.score ?? 0));
  if (bestTeammateScore <= 0) {
    return null;
  }

  return self.score / bestTeammateScore;
}

function isUniqueMax(value: number, otherValues: number[]): boolean {
  return otherValues.every((other) => other < value);
}

function parseCurrentSeasonStats(seasonal: unknown): { wins: number | null; games: number | null } {
  if (!Array.isArray(seasonal) || seasonal.length === 0) {
    return { wins: null, games: null };
  }

  const entries = seasonal.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
  );

  // L'acte en cours est celui dont le code de saison ("e11a4", "v25a3"...) est le plus
  // recent : on ne se fie pas a l'ordre du tableau, non documente.
  let current: Record<string, unknown> | null = null;
  let bestOrder = -1;
  for (const entry of entries) {
    const season = entry.season && typeof entry.season === "object" && !Array.isArray(entry.season)
      ? entry.season as Record<string, unknown>
      : null;
    const order = parseSeasonOrder(readOptionalString(season?.short));
    if (order !== null && order > bestOrder) {
      bestOrder = order;
      current = entry;
    }
  }
  current ??= entries[entries.length - 1] ?? null;
  if (!current) {
    return { wins: null, games: null };
  }

  // "act_wins" liste chaque victoire de l'acte (placements compris), alors que "wins"
  // exclut les victoires de placement : on prefere le decompte complet, coherent avec
  // l'affichage du jeu et des sites de tracking.
  const actWins = Array.isArray(current.act_wins) ? current.act_wins.length : null;
  return {
    wins: actWins ?? readOptionalNumber(current.wins),
    games: readOptionalNumber(current.games)
  };
}

function parseSeasonOrder(short: string | null): number | null {
  if (!short) {
    return null;
  }

  const match = /^[a-z](\d+)a(\d+)$/i.exec(short.trim());
  if (!match) {
    return null;
  }

  return Number(match[1]) * 100 + Number(match[2]);
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }

  return value as Record<string, unknown>;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array`);
  }

  return value;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty string`);
  }

  return value;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildAgentPortraitUrl(agentId: string | null): string | null {
  if (!agentId) {
    return null;
  }

  return `https://media.valorant-api.com/agents/${agentId}/displayicon.png`;
}

function buildMapSplashUrl(mapId: string | null): string | null {
  if (!mapId) {
    return null;
  }

  return `https://media.valorant-api.com/maps/${mapId}/splash.png`;
}
