import type {
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

    return {
      rankTier: readOptionalNumber(tier.id),
      rankName: readOptionalString(tier.name),
      rankingInTier: readOptionalNumber(currentData.rr),
      lastRrChange: readOptionalNumber(currentData.last_change)
    };
  }

  public async getLatestCompetitiveMatch(player: PlayerIdentity): Promise<MatchSummary | null> {
    const matches = await this.getCompetitiveMatches(player, 1);
    return matches[0] ?? null;
  }

  private async getCompetitiveMatches(
    player: PlayerIdentity,
    size: number
  ): Promise<MatchSummary[]> {
    const response = await this.getJson(
      `/valorant/v4/by-puuid/matches/${encodeURIComponent(player.region)}/pc/${encodeURIComponent(player.puuid)}?mode=competitive&size=${size}`
    );

    const matches = expectArray(response.data, "matches");
    return matches
      .filter((match): match is Record<string, unknown> => Boolean(match) && typeof match === "object")
      .map((match) => parseMatchSummary(match, player.puuid));
  }

  private async getJson(path: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: this.apiKey,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HenrikDev request failed with ${response.status}: ${body}`);
    }

    const data = await response.json() as unknown;
    if (!data || typeof data !== "object") {
      throw new Error("HenrikDev response was not an object");
    }

    return data as Record<string, unknown>;
  }
}

function parseRiotId(riotId: string): { gameName: string; tagLine: string } {
  const [gameName, tagLine, ...rest] = riotId.split("#");
  if (!gameName || !tagLine || rest.length > 0) {
    throw new Error(`Invalid Riot ID "${riotId}". Expected "<name>#<tag>"`);
  }

  return { gameName, tagLine };
}

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

  return {
    matchId: expectString(metadata.match_id, "match metadata.match_id"),
    mode: readOptionalString(queue?.name) ?? "Competitive",
    mapName: readOptionalString(map?.name) ?? "Carte inconnue",
    startedAt: readOptionalString(metadata.started_at),
    seasonShort: readOptionalString(season?.short),
    gameLengthInMs: readOptionalNumber(metadata.game_length_in_ms),
    agentName: readOptionalString(agent?.name),
    agentPortraitUrl: buildAgentPortraitUrl(readOptionalString(agent?.id)),
    kills: readOptionalNumber(stats.kills),
    deaths: readOptionalNumber(stats.deaths),
    assists: readOptionalNumber(stats.assists),
    score: readOptionalNumber(stats.score),
    teamScore: readOptionalNumber(rounds?.won),
    opponentScore: readOptionalNumber(opponentRounds?.won),
    didWin: typeof teamEntry?.won === "boolean" ? teamEntry.won : null
  };
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
