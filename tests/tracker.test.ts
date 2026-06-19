import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TrackerStore } from "../src/db.js";
import { formatLeaderboard, formatMatchSummary } from "../src/format.js";
import { HenrikDevProvider } from "../src/providers/henrikdev.js";
import { TrackerService } from "../src/tracker.js";
import type {
  DiscordWebhookClient,
  DiscordWebhookPayload,
  MatchSummary,
  PlayerIdentity,
  PlayerSnapshot,
  ResolvedPlayer,
  TrackerProvider
} from "../src/types.js";

class FakeProvider implements TrackerProvider {
  public resolvedPlayer: ResolvedPlayer = {
    gameName: "Demo",
    tagLine: "EUW",
    region: "eu",
    puuid: "puuid-1",
    displayName: "Demo#EUW"
  };

  public latestMatch: MatchSummary | null = null;
  public latestMatchesByPuuid: Map<string, MatchSummary | null> = new Map();
  public recentMatches: MatchSummary[] | null = null;
  public recentMatchesByPuuid: Map<string, MatchSummary[]> = new Map();
  public snapshot: PlayerSnapshot = {
    rankTier: 12,
    rankName: "Gold 1",
    rankingInTier: 42,
    lastRrChange: null
  };
  public snapshotsByPuuid: Map<string, PlayerSnapshot> = new Map();

  public shouldFailFor: Set<string> = new Set();

  public async resolvePlayer(): Promise<ResolvedPlayer> {
    return this.resolvedPlayer;
  }

  public async getPlayerSnapshot(player: PlayerIdentity): Promise<PlayerSnapshot> {
    if (this.shouldFailFor.has(player.puuid)) {
      throw new Error("provider exploded");
    }

    return this.snapshotsByPuuid.get(player.puuid) ?? this.snapshot;
  }

  public async getLatestCompetitiveMatch(player: PlayerIdentity): Promise<MatchSummary | null> {
    if (this.shouldFailFor.has(player.puuid)) {
      throw new Error("provider exploded");
    }

    return this.latestMatchesByPuuid.get(player.puuid) ?? this.latestMatch;
  }

  public async getRecentCompetitiveMatches(player: PlayerIdentity, limit: number): Promise<MatchSummary[]> {
    if (this.shouldFailFor.has(player.puuid)) {
      throw new Error("provider exploded");
    }

    const matches = this.recentMatchesByPuuid.get(player.puuid) ?? this.recentMatches ?? (this.latestMatch ? [this.latestMatch] : []);
    return matches.slice(0, limit);
  }
}

class FakeWebhook implements DiscordWebhookClient {
  public readonly payloads: DiscordWebhookPayload[] = [];

  public async postMessage(payload: DiscordWebhookPayload): Promise<void> {
    this.payloads.push(payload);
  }

  public async checkConnection(): Promise<void> {}
}

const stores: TrackerStore[] = [];

afterEach(async () => {
  while (stores.length > 0) {
    stores.pop()!.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 25));
});

describe("TrackerService", () => {
  it("stores canonical player identity and seeds the last processed match id", async () => {
    const { service, store, provider } = createHarness();
    const tracker = await service;
    const db = await store;
    provider.latestMatch = createMatch("match-1");

    await tracker.addPlayer("Input#Tag", "eu");

    const players = await db.listTrackedPlayers();
    expect(players).toHaveLength(1);
    expect(players[0]?.gameName).toBe("Demo");
    expect(players[0]?.tagLine).toBe("EUW");

    const state = await db.getPlayerState(players[0]!.id);
    expect(state.lastProcessedMatchId).toBe("match-1");
  });

  it("falls back to riot id display when display name is blank", async () => {
    const { service, store } = createHarness();
    const tracker = await service;
    const db = await store;

    await tracker.addPlayer("Input#Tag", "eu", "   ");

    const entries = await db.getLeaderboardEntries();
    expect(entries[0]?.displayName).toBe("Demo#EUW");
  });

  it("does not post when the latest competitive match is unchanged", async () => {
    const { service, provider, webhook } = createHarness();
    const tracker = await service;
    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    provider.snapshot = {
      ...provider.snapshot,
      rankingInTier: 55,
      lastRrChange: 15
    };

    const result = await tracker.pollMatches();
    expect(result.postedMatches).toBe(0);
    expect(webhook.payloads).toHaveLength(0);
  });

  it("posts all unposted competitive matches oldest first and updates state", async () => {
    const { service, provider, store, webhook } = createHarness();
    const tracker = await service;
    const db = await store;
    provider.latestMatch = createMatch("match-1");
    provider.snapshot = {
      rankTier: 12,
      rankName: "Gold 1",
      rankingInTier: 40,
      lastRrChange: null
    };
    await tracker.addPlayer("Input#Tag", "eu");

    provider.recentMatches = [
      createMatch("match-3", "2026-06-19T20:00:00.000Z"),
      createMatch("match-2", "2026-06-19T19:00:00.000Z"),
      createMatch("match-1", "2026-06-19T18:00:00.000Z")
    ];
    provider.snapshot = {
      rankTier: 12,
      rankName: "Gold 1",
      rankingInTier: 72,
      lastRrChange: 11
    };

    const result = await tracker.pollMatches();

    expect(result.postedMatches).toBe(2);
    expect(webhook.payloads).toHaveLength(2);
    const firstEmbed = webhook.payloads[0]?.embeds?.[0] as Record<string, unknown>;
    const secondEmbed = webhook.payloads[1]?.embeds?.[0] as Record<string, unknown>;
    const firstFields = firstEmbed.fields as Array<Record<string, unknown>>;
    const secondFields = secondEmbed.fields as Array<Record<string, unknown>>;
    expect(String(firstEmbed.footer && (firstEmbed.footer as Record<string, unknown>).text)).toContain("match-2");
    expect(String(secondEmbed.footer && (secondEmbed.footer as Record<string, unknown>).text)).toContain("match-3");
    expect(firstFields.find((field) => field.name === "RR")?.value).toBe("N/A");
    expect(secondFields.find((field) => field.name === "RR")?.value).toBe("+11 RR");

    const player = (await db.listTrackedPlayers())[0]!;
    const state = await db.getPlayerState(player.id);
    expect(state.lastProcessedMatchId).toBe("match-3");
    expect(state.rankingInTier).toBe(72);

    const secondPoll = await tracker.pollMatches();
    expect(secondPoll.postedMatches).toBe(0);
    expect(webhook.payloads).toHaveLength(2);
  });

  it("keeps processing other players when one player fails", async () => {
    const { service, provider, store, webhook } = createHarness();
    const tracker = await service;
    const db = await store;
    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    provider.resolvedPlayer = {
      gameName: "Other",
      tagLine: "EUW",
      region: "eu",
      puuid: "puuid-2",
      displayName: "Other#EUW"
    };
    provider.latestMatch = createMatch("match-2");
    await tracker.addPlayer("Other#EUW", "eu");

    const players = await db.listTrackedPlayers();
    provider.shouldFailFor.add(players[0]!.puuid);

    provider.latestMatch = createMatch("match-3");
    provider.snapshot = {
      rankTier: 15,
      rankName: "Platinum 1",
      rankingInTier: 12,
      lastRrChange: null
    };

    const result = await tracker.pollMatches();

    expect(result.failures).toHaveLength(1);
    expect(result.postedMatches).toBe(1);
    expect(webhook.payloads).toHaveLength(1);
  });

  it("can post the latest tracked match manually", async () => {
    const { service, provider, webhook } = createHarness();
    const tracker = await service;

    provider.latestMatch = createMatch("match-1", "2026-06-19T18:00:00.000Z");
    await tracker.addPlayer("Input#Tag", "eu");
    provider.latestMatchesByPuuid.set("puuid-1", createMatch("match-1", "2026-06-19T18:00:00.000Z"));

    provider.resolvedPlayer = {
      gameName: "Other",
      tagLine: "EUW",
      region: "eu",
      puuid: "puuid-2",
      displayName: "Other#EUW"
    };
    provider.latestMatch = createMatch("match-2", "2026-06-19T19:30:00.000Z");
    await tracker.addPlayer("Other#EUW", "eu");
    provider.latestMatchesByPuuid.set("puuid-2", createMatch("match-2", "2026-06-19T19:30:00.000Z"));

    const result = await tracker.postLatestTrackedMatch();

    expect(result.posted).toBe(true);
    expect(webhook.payloads).toHaveLength(1);
    const embed = webhook.payloads[0]?.embeds?.[0] as Record<string, unknown>;
    expect(String(embed.title)).toContain("Other#EUW");
  });
});

describe("formatters", () => {
  it("sorts leaderboard entries by rank and RR and renders rank-only rows", () => {
    const payload = formatLeaderboard([
      {
        playerId: 1,
        displayName: "SameRankHigherRR",
        rankTier: 12,
        rankName: "Gold 1",
        rankingInTier: 85
      },
      {
        playerId: 2,
        displayName: "Higher",
        rankTier: 13,
        rankName: "Gold 2",
        rankingInTier: 40
      },
      {
        playerId: 3,
        displayName: "SameRankLowerRR",
        rankTier: 12,
        rankName: "Gold 1",
        rankingInTier: 20
      }
    ]);

    const embed = payload.embeds?.[0] as Record<string, unknown>;
    const description = String(embed.description);
    expect(String(embed.title)).toContain("Leaderboard Quotidien");
    expect(description).toContain("1 - Higher");
    expect(description).toContain("GOLD 2 - 40 RR");
    expect(description).toContain("2 - SameRankHigherRR");
    expect(description).toContain("3 - SameRankLowerRR");
    expect(description).not.toContain("%WR");
    expect(description).not.toContain("[G]");
  });

  it("renders compact match card with portrait and essential stats", () => {
    const payload = formatMatchSummary({
      playerDisplayName: "Demo#EUW",
      matchId: "abc",
      mode: "Competitive",
      mapName: "Ascent",
      startedAt: null,
      seasonShort: "e11a3",
      gameLengthInMs: 1765000,
      agentName: "Sova",
      agentPortraitUrl: "https://media.valorant-api.com/agents/test/displayicon.png",
      kills: 21,
      deaths: 14,
      assists: 9,
      score: 320,
      teamScore: 13,
      opponentScore: 9,
      didWin: true,
      rrDelta: 17
    });

    const embed = payload.embeds?.[0] as Record<string, unknown>;
    const fields = embed.fields as Array<Record<string, unknown>>;
    expect(String(embed.title)).toContain("Demo#EUW");
    expect(String(embed.description)).toContain("Victoire");
    expect(String(fields[0]?.name)).toBe("Carte");
    expect(String(fields[1]?.value)).toContain("13-9");
    expect(String(fields[2]?.value)).toContain("21/14/9");
    expect(String(fields[3]?.value)).toContain("29:25");
    expect(String(fields[4]?.value)).toContain("+17 RR");
  });
});

describe("HenrikDevProvider", () => {
  it("reads current rank and RR delta from the current HenrikDev MMR payload", async () => {
    const responses = [
      {
        status: 200,
        data: {
          current: {
            tier: {
              id: 16,
              name: "Platinum 2"
            },
            rr: 60,
            last_change: 18
          }
        }
      }
    ];

    const provider = new HenrikDevProvider({
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    });

    const snapshot = await provider.getPlayerSnapshot({
      gameName: "Maverick",
      tagLine: "7900",
      region: "eu",
      puuid: "867e1d40-64ba-5da0-9e6c-dec45f2fcfa3"
    });

    expect(snapshot.rankName).toBe("Platinum 2");
    expect(snapshot.rankingInTier).toBe(60);
    expect(snapshot.lastRrChange).toBe(18);
  });
});

function createHarness(): {
  service: Promise<TrackerService>;
  store: Promise<TrackerStore>;
  provider: FakeProvider;
  webhook: FakeWebhook;
} {
  const dir = mkdtempSync(join(tmpdir(), "valo-tracker-"));
  const provider = new FakeProvider();
  const webhook = new FakeWebhook();
  const store = TrackerStore.open({ url: `file:${join(dir, "tracker.sqlite")}` });
  const service = store.then((resolvedStore) => {
    stores.push(resolvedStore);
    return new TrackerService(resolvedStore, provider, webhook);
  });

  return { service, store, provider, webhook };
}

function createMatch(matchId: string, startedAt = "2026-06-19T18:00:00.000Z"): MatchSummary {
  return {
    matchId,
    mode: "Competitive",
    mapName: "Ascent",
    startedAt,
    seasonShort: "e11a3",
    gameLengthInMs: 1765000,
    agentName: "Sova",
    agentPortraitUrl: "https://media.valorant-api.com/agents/test/displayicon.png",
    kills: 20,
    deaths: 15,
    assists: 10,
    score: 315,
    teamScore: 13,
    opponentScore: 9,
    didWin: true
  };
}

function createApiMatch(
  puuid: string,
  input: {
    matchId: string;
    seasonShort: string;
    didWin: boolean;
  }
): Record<string, unknown> {
  return {
    metadata: {
      match_id: input.matchId,
      started_at: "2026-06-19T18:00:00.000Z",
      game_length_in_ms: 1765000,
      queue: {
        name: "Competitive"
      },
      map: {
        name: "Ascent"
      },
      season: {
        short: input.seasonShort
      }
    },
    players: [
      {
        puuid,
        team_id: "Blue",
        agent: {
          id: "test-agent-id",
          name: "Sova"
        },
        stats: {
          kills: 20,
          deaths: 15,
          assists: 10,
          score: 315
        }
      }
    ],
    teams: [
      {
        team_id: "Blue",
        won: input.didWin,
        rounds: {
          won: input.didWin ? 13 : 9
        }
      },
      {
        team_id: "Red",
        won: !input.didWin,
        rounds: {
          won: input.didWin ? 9 : 13
        }
      }
    ]
  };
}
