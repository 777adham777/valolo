import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TrackerStore } from "../src/db.js";
import { formatLeaderboard, formatMatchSummary } from "../src/format.js";
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
  public snapshot: PlayerSnapshot = {
    rankTier: 12,
    rankName: "Gold 1",
    rankingInTier: 42,
    wins: 8,
    games: 10,
    winRate: 80
  };

  public shouldFailFor: Set<string> = new Set();

  public async resolvePlayer(): Promise<ResolvedPlayer> {
    return this.resolvedPlayer;
  }

  public async getPlayerSnapshot(player: PlayerIdentity): Promise<PlayerSnapshot> {
    if (this.shouldFailFor.has(player.puuid)) {
      throw new Error("provider exploded");
    }

    return this.snapshot;
  }

  public async getLatestCompetitiveMatch(player: PlayerIdentity): Promise<MatchSummary | null> {
    if (this.shouldFailFor.has(player.puuid)) {
      throw new Error("provider exploded");
    }

    return this.latestMatch;
  }
}

class FakeWebhook implements DiscordWebhookClient {
  public readonly payloads: DiscordWebhookPayload[] = [];

  public async postMessage(payload: DiscordWebhookPayload): Promise<void> {
    this.payloads.push(payload);
  }
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

  it("does not post when the latest competitive match is unchanged", async () => {
    const { service, provider, webhook } = createHarness();
    const tracker = await service;
    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    provider.snapshot = {
      ...provider.snapshot,
      rankingInTier: 55
    };

    const result = await tracker.pollMatches();
    expect(result.postedMatches).toBe(0);
    expect(webhook.payloads).toHaveLength(0);
  });

  it("posts exactly once for a new competitive match and updates state", async () => {
    const { service, provider, store, webhook } = createHarness();
    const tracker = await service;
    const db = await store;
    provider.latestMatch = createMatch("match-1");
    provider.snapshot = {
      rankTier: 12,
      rankName: "Gold 1",
      rankingInTier: 40,
      wins: 8,
      games: 10,
      winRate: 80
    };
    await tracker.addPlayer("Input#Tag", "eu");

    provider.latestMatch = createMatch("match-2");
    provider.snapshot = {
      rankTier: 12,
      rankName: "Gold 1",
      rankingInTier: 61,
      wins: 9,
      games: 11,
      winRate: 81.8
    };

    const result = await tracker.pollMatches();

    expect(result.postedMatches).toBe(1);
    expect(webhook.payloads).toHaveLength(1);

    const player = (await db.listTrackedPlayers())[0]!;
    const state = await db.getPlayerState(player.id);
    expect(state.lastProcessedMatchId).toBe("match-2");
    expect(state.rankingInTier).toBe(61);
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
      wins: 10,
      games: 14,
      winRate: 71.4
    };

    const result = await tracker.pollMatches();

    expect(result.failures).toHaveLength(1);
    expect(result.postedMatches).toBe(1);
    expect(webhook.payloads).toHaveLength(1);
  });
});

describe("formatters", () => {
  it("sorts leaderboard entries consistently and renders rank plus win rate", () => {
    const payload = formatLeaderboard([
      {
        playerId: 1,
        displayName: "Lower",
        rankTier: 10,
        rankName: "Silver 3",
        rankingInTier: 85,
        winRate: 60,
        wins: 6,
        games: 10
      },
      {
        playerId: 2,
        displayName: "Higher",
        rankTier: 12,
        rankName: "Gold 1",
        rankingInTier: 40,
        winRate: 55.6,
        wins: 5,
        games: 9
      }
    ]);

    const description = String(payload.embeds?.[0]?.description);
    expect(description).toContain("Higher");
    expect(description).toContain("Gold 1");
    expect(description).toContain("55.6% (5/9)");
  });

  it("renders rank changes gracefully when values are missing", () => {
    const payload = formatMatchSummary({
      playerDisplayName: "Demo#EUW",
      matchId: "abc",
      mode: "Competitive",
      mapName: "Ascent",
      startedAt: null,
      agentName: null,
      kills: 21,
      deaths: 14,
      assists: 9,
      score: 320,
      teamScore: 13,
      opponentScore: 9,
      didWin: true,
      rankBefore: null,
      rankAfter: "Gold 2",
      rrBefore: null,
      rrAfter: 55,
      rrDelta: null
    });

    const embed = payload.embeds?.[0] as Record<string, unknown>;
    const fields = embed.fields as Array<Record<string, unknown>>;
    expect(String(fields[1]?.value)).toContain("Unknown -> Gold 2");
    expect(String(fields[2]?.value)).toContain("N/A -> 55 RR");
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

function createMatch(matchId: string): MatchSummary {
  return {
    matchId,
    mode: "Competitive",
    mapName: "Ascent",
    startedAt: "2026-06-19T18:00:00.000Z",
    agentName: "Sova",
    kills: 20,
    deaths: 15,
    assists: 10,
    score: 315,
    teamScore: 13,
    opponentScore: 9,
    didWin: true
  };
}
