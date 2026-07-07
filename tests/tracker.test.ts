import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { TrackerStore } from "../src/db.js";
import { formatLeaderboard, formatMatchSummary } from "../src/format.js";
import { HenrikDevProvider } from "../src/providers/henrikdev.js";
import { TrackerService } from "../src/tracker.js";
import { getPunchlines } from "../src/punchlines.js";
import type {
  DiscordWebhookClient,
  DiscordWebhookPayload,
  MatchHighlights,
  MatchRrChange,
  MatchSummary,
  MatchSummaryPost,
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
    lastRrChange: null,
    wins: null,
    games: null
  };
  public snapshotsByPuuid: Map<string, PlayerSnapshot> = new Map();
  public rrChangesByPuuid: Map<string, Map<string, MatchRrChange>> = new Map();

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

  public async getMatchRrChanges(player: PlayerIdentity): Promise<Map<string, MatchRrChange>> {
    if (this.shouldFailFor.has(player.puuid)) {
      throw new Error("provider exploded");
    }

    const explicit = this.rrChangesByPuuid.get(player.puuid);
    if (explicit) {
      return explicit;
    }

    // Par defaut l'historique MMR reflete la liste des matchs, comme dans la vraie API.
    const matches = await this.getRecentCompetitiveMatches(player, 50);
    return new Map(matches.map((match) => [match.matchId, {
      matchId: match.matchId,
      startedAt: match.startedAt,
      rrChange: null,
      rrAfter: null,
      rankTierAfter: null,
      rankNameAfter: null
    }]));
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
      lastRrChange: null,
      wins: null,
      games: null
    };
    await tracker.addPlayer("Input#Tag", "eu");

    provider.recentMatches = [
      createMatch("match-3", "2026-06-19T20:00:00.000Z"),
      createMatch("match-2", "2026-06-19T19:00:00.000Z"),
      { ...createMatch("match-1", "2026-06-19T18:00:00.000Z"), didWin: false }
    ];
    provider.snapshot = {
      rankTier: 12,
      rankName: "Gold 1",
      rankingInTier: 72,
      lastRrChange: 11,
      wins: null,
      games: null
    };

    const result = await tracker.pollMatches();

    expect(result.postedMatches).toBe(2);
    expect(webhook.payloads).toHaveLength(2);
    const firstEmbed = webhook.payloads[0]?.embeds?.[0] as Record<string, unknown>;
    const secondEmbed = webhook.payloads[1]?.embeds?.[0] as Record<string, unknown>;
    expect(String(firstEmbed.timestamp)).toBe("2026-06-19T19:00:00.000Z");
    expect(String(secondEmbed.timestamp)).toBe("2026-06-19T20:00:00.000Z");
    expect(String(firstEmbed.description)).toContain("RR N/A");
    expect(String(secondEmbed.description)).toContain("**+11 RR** → Gold 1 (72 RR)");

    const player = (await db.listTrackedPlayers())[0]!;
    const state = await db.getPlayerState(player.id);
    expect(state.lastProcessedMatchId).toBe("match-3");
    expect(state.rankingInTier).toBe(72);

    const secondPoll = await tracker.pollMatches();
    expect(secondPoll.postedMatches).toBe(0);
    expect(webhook.payloads).toHaveLength(2);
  });

  it("uses the exact RR change from the MMR history for every posted match", async () => {
    const { service, provider, webhook } = createHarness();
    const tracker = await service;
    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    provider.recentMatches = [
      createMatch("match-3", "2026-06-19T20:00:00.000Z"),
      createMatch("match-2", "2026-06-19T19:00:00.000Z"),
      createMatch("match-1", "2026-06-19T18:00:00.000Z")
    ];
    provider.snapshot = {
      rankTier: 13,
      rankName: "Gold 2",
      rankingInTier: 10,
      lastRrChange: 22,
      wins: null,
      games: null
    };
    provider.rrChangesByPuuid.set("puuid-1", new Map([
      ["match-2", { matchId: "match-2", startedAt: "2026-06-19T19:00:00.000Z", rrChange: -14, rrAfter: 88, rankTierAfter: 12, rankNameAfter: "Gold 1" }],
      ["match-3", { matchId: "match-3", startedAt: "2026-06-19T20:00:00.000Z", rrChange: 22, rrAfter: 10, rankTierAfter: 13, rankNameAfter: "Gold 2" }]
    ]));

    const result = await tracker.pollMatches();

    expect(result.postedMatches).toBe(2);
    const firstDescription = String((webhook.payloads[0]?.embeds?.[0] as Record<string, unknown>).description);
    const secondDescription = String((webhook.payloads[1]?.embeds?.[0] as Record<string, unknown>).description);
    expect(firstDescription).toContain("**-14 RR** → Gold 1 (88 RR)");
    expect(secondDescription).toContain("**+22 RR** → Gold 2 (10 RR)");
  });

  it("retries later when the MMR history announces a match not yet visible in the matches endpoint", async () => {
    const { service, provider, store, webhook } = createHarness();
    const tracker = await service;
    const db = await store;
    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    const freshDate = new Date().toISOString();
    provider.rrChangesByPuuid.set("puuid-1", new Map([
      ["match-1", { matchId: "match-1", startedAt: "2026-06-19T18:00:00.000Z", rrChange: null, rrAfter: null, rankTierAfter: null, rankNameAfter: null }],
      ["match-2", { matchId: "match-2", startedAt: freshDate, rrChange: 17, rrAfter: 59, rankTierAfter: 12, rankNameAfter: "Gold 1" }]
    ]));
    provider.recentMatchesByPuuid.set("puuid-1", [createMatch("match-1")]);

    const firstPoll = await tracker.pollMatches();
    expect(firstPoll.postedMatches).toBe(0);
    expect(webhook.payloads).toHaveLength(0);

    // Le curseur ne doit pas avoir avance : le match sera retente au prochain poll.
    const player = (await db.listTrackedPlayers())[0]!;
    expect((await db.getPlayerState(player.id)).lastProcessedMatchId).toBe("match-1");

    // Le match devient visible : il est poste avec son delta RR exact.
    provider.recentMatchesByPuuid.set("puuid-1", [createMatch("match-2", freshDate), createMatch("match-1")]);
    const secondPoll = await tracker.pollMatches();
    expect(secondPoll.postedMatches).toBe(1);
    const description = String((webhook.payloads[0]?.embeds?.[0] as Record<string, unknown>).description);
    expect(description).toContain("**+17 RR** → Gold 1 (59 RR)");
    expect((await db.getPlayerState(player.id)).lastProcessedMatchId).toBe("match-2");
  });

  it("groups tracked players who played the same match into a single ranked message", async () => {
    const { service, provider, webhook } = createHarness();
    const tracker = await service;

    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    provider.resolvedPlayer = {
      gameName: "Other",
      tagLine: "EUW",
      region: "eu",
      puuid: "puuid-2",
      displayName: "Other#EUW"
    };
    await tracker.addPlayer("Other#EUW", "eu");

    const sharedForDemo = createMatch("match-9", "2026-06-20T18:00:00.000Z");
    const sharedForOther = { ...createMatch("match-9", "2026-06-20T18:00:00.000Z"), kills: 30, score: 7000 };
    provider.recentMatchesByPuuid.set("puuid-1", [sharedForDemo, createMatch("match-1")]);
    provider.recentMatchesByPuuid.set("puuid-2", [sharedForOther, createMatch("match-1")]);

    const result = await tracker.pollMatches();

    expect(result.postedMatches).toBe(1);
    expect(webhook.payloads).toHaveLength(1);
    const embed = webhook.payloads[0]?.embeds?.[0] as Record<string, unknown>;
    const author = embed.author as Record<string, unknown>;
    const fields = embed.fields as Array<Record<string, unknown>>;
    expect(String(author.name)).toContain("2 joueurs suivis");
    expect(String(embed.title)).toContain("Victoire 13-9");
    expect(String(fields[0]?.name)).toContain("🥇");
    expect(String(fields[0]?.name)).toContain("Other#EUW");
    expect(String(fields[1]?.name)).toContain("🥈");
    expect(String(fields[1]?.name)).toContain("Demo#EUW");

    const secondPoll = await tracker.pollMatches();
    expect(secondPoll.postedMatches).toBe(0);
    expect(webhook.payloads).toHaveLength(1);
  });

  it("announces a win streak after the match summaries", async () => {
    const { service, provider, webhook } = createHarness();
    const tracker = await service;
    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    provider.recentMatches = [
      createMatch("match-4", "2026-06-19T21:00:00.000Z"),
      createMatch("match-3", "2026-06-19T20:00:00.000Z"),
      createMatch("match-2", "2026-06-19T19:00:00.000Z"),
      createMatch("match-1", "2026-06-19T18:00:00.000Z")
    ];

    const result = await tracker.pollMatches();

    expect(result.postedMatches).toBe(3);
    expect(webhook.payloads).toHaveLength(4);
    const announcement = webhook.payloads[3]?.embeds?.[0] as Record<string, unknown>;
    expect(String(announcement.description)).toContain("4 victoires d'affilée");
    expect(String(announcement.description)).toContain("Demo#EUW");

    const secondPoll = await tracker.pollMatches();
    expect(secondPoll.postedMatches).toBe(0);
    expect(webhook.payloads).toHaveLength(4);
  });

  it("announces rank promotions after a match", async () => {
    const { service, provider, webhook } = createHarness();
    const tracker = await service;
    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    provider.recentMatches = [
      createMatch("match-2", "2026-06-19T19:00:00.000Z"),
      createMatch("match-1", "2026-06-19T18:00:00.000Z")
    ];
    provider.snapshot = {
      rankTier: 13,
      rankName: "Gold 2",
      rankingInTier: 5,
      lastRrChange: 21,
      wins: null,
      games: null
    };

    const result = await tracker.pollMatches();

    expect(result.postedMatches).toBe(1);
    expect(webhook.payloads).toHaveLength(2);
    const announcement = webhook.payloads[1]?.embeds?.[0] as Record<string, unknown>;
    expect(String(announcement.description)).toContain("est monté");
    expect(String(announcement.description)).toContain("Gold 2");
  });

  it("records match stats and posts the weekly recap", async () => {
    const { service, provider, webhook } = createHarness();
    const tracker = await service;
    provider.latestMatch = createMatch("match-1");
    await tracker.addPlayer("Input#Tag", "eu");

    provider.recentMatches = [
      createMatch("match-2", new Date().toISOString()),
      createMatch("match-1")
    ];
    provider.snapshot = {
      ...provider.snapshot,
      rankingInTier: 53,
      lastRrChange: 11
    };

    await tracker.pollMatches();
    webhook.payloads.length = 0;

    const result = await tracker.postWeeklyRecap();

    expect(result.posted).toBe(true);
    expect(webhook.payloads).toHaveLength(1);
    const embed = webhook.payloads[0]?.embeds?.[0] as Record<string, unknown>;
    expect(String(embed.title)).toContain("Cérémonie");
    expect(String(embed.description)).toContain("MVP de la semaine");
    expect(String(embed.description)).toContain("Demo#EUW");
    expect(String(embed.description)).toContain("+11 RR");
    const fields = embed.fields as Array<Record<string, unknown>>;
    expect(String(fields[0]?.value)).toContain("1 game");
    expect(String(fields[0]?.value)).toContain("1V/0D");
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
      lastRrChange: null,
      wins: null,
      games: null
    };

    const result = await tracker.pollMatches();

    expect(result.failures).toHaveLength(1);
    expect(result.postedMatches).toBe(1);
    // 1 resume de match + 1 annonce de promotion (Gold 1 -> Platinum 1)
    expect(webhook.payloads).toHaveLength(2);
    const promotion = webhook.payloads[1]?.embeds?.[0] as Record<string, unknown>;
    expect(String(promotion.description)).toContain("est monté");
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
    const author = embed.author as Record<string, unknown>;
    expect(String(author.name)).toContain("Other#EUW");
  });
});

describe("formatters", () => {
  it("sorts leaderboard entries by rank and RR and renders one embed per player with rank icon", () => {
    const payloads = formatLeaderboard([
      {
        playerId: 1,
        displayName: "SameRankHigherRR",
        rankTier: 12,
        rankName: "Gold 1",
        rankingInTier: 85,
        wins: 12,
        games: 20,
        winRate: 60
      },
      {
        playerId: 2,
        displayName: "Higher",
        rankTier: 13,
        rankName: "Gold 2",
        rankingInTier: 40,
        wins: null,
        games: null,
        winRate: null
      },
      {
        playerId: 3,
        displayName: "Unranked",
        rankTier: null,
        rankName: null,
        rankingInTier: null,
        wins: null,
        games: null,
        winRate: null
      }
    ]);

    expect(payloads).toHaveLength(1);
    const embeds = payloads[0]?.embeds as Array<Record<string, unknown>>;
    expect(embeds).toHaveLength(4);
    expect(String(embeds[0]?.title)).toContain("Leaderboard Quotidien");

    const first = embeds[1] as { author: { name: string; icon_url?: string }; description: string };
    const second = embeds[2] as { author: { name: string; icon_url?: string }; description: string };
    const third = embeds[3] as { author: { name: string; icon_url?: string }; description: string };

    expect(first.author.name).toContain("🥇");
    expect(first.author.name).toContain("Higher");
    expect(first.author.icon_url).toBe("https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/13/smallicon.png");
    expect(first.description).toContain("Gold 2");
    expect(first.description).toContain("40 RR");

    expect(second.author.name).toContain("🥈");
    expect(second.author.name).toContain("SameRankHigherRR");
    expect(second.description).toContain("12V / 8D");
    expect(second.description).toContain("60% WR");

    expect(third.author.name).toContain("🥉");
    expect(third.author.name).toContain("Unranked");
    expect(third.author.icon_url).toBeUndefined();
    expect(third.description).toContain("Non classé");
  });

  it("splits the leaderboard into several messages beyond 10 embeds", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      playerId: index + 1,
      displayName: `Player${String(index + 1).padStart(2, "0")}`,
      rankTier: 12,
      rankName: "Gold 1",
      rankingInTier: 50 - index,
      wins: null,
      games: null,
      winRate: null
    }));

    const payloads = formatLeaderboard(entries);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.embeds).toHaveLength(10);
    expect(payloads[1]?.embeds).toHaveLength(3);
  });

  it("renders compact match card with portrait, rank icon and essential stats", () => {
    const payload = formatMatchSummary([
      createPost({
        kills: 21,
        deaths: 14,
        assists: 9,
        headshots: 14,
        bodyshots: 32,
        legshots: 4,
        score: 5280,
        roundsPlayed: 22,
        rrDelta: 17,
        rankTierAfter: 18,
        rankNameAfter: "Diamond 1",
        rrAfter: 45
      })
    ]);

    const embed = payload.embeds?.[0] as Record<string, unknown>;
    const author = embed.author as Record<string, unknown>;
    const thumbnail = embed.thumbnail as Record<string, unknown>;
    const footer = embed.footer as Record<string, unknown>;
    const description = String(embed.description);

    expect(String(author.name)).toContain("Demo#EUW");
    expect(String(author.icon_url)).toContain("/competitivetiers/");
    expect(String(author.icon_url)).toContain("/18/");
    expect(String(embed.title)).toContain("Victoire 13-9");
    expect(String(embed.title)).toContain("Ascent");
    expect(String(thumbnail.url)).toContain("displayicon.png");
    expect(description).toContain("**21 / 14 / 9**");
    expect(description).toContain("1.50 KD");
    expect(description).toContain("**240** ACS");
    expect(description).toContain("**28%** HS");
    expect(description).toContain("**+17 RR** → Diamond 1 (45 RR)");
    expect(description).not.toContain(">"); // pas de punchline sur une game moyenne
    expect(description).toContain("⠀"); // ligne de remplissage pour largeur fixe
    expect(String(footer.text)).toBe("Sova · Competitive · 29:25");
    expect(embed.fields).toBeUndefined();
  });

  it("dedupes team punchlines in grouped match cards", () => {
    const payload = formatMatchSummary([
      createPost({ didWin: false, playerDisplayName: "Alice" }, { teamChoked: true }),
      createPost({ didWin: false, playerDisplayName: "Bob", score: 4000 }, { teamChoked: true })
    ], () => 0);

    const embed = payload.embeds?.[0] as Record<string, unknown>;
    const description = String(embed.description);
    const chokeOccurrences = description.split("choke").length - 1;
    expect(chokeOccurrences).toBe(1);
  });

  it("awards the wooden spoon when two tracked players share the lobby bottom", () => {
    const payload = formatMatchSummary([
      createPost({ playerDisplayName: "Alice", score: 6000 }),
      createPost({ playerDisplayName: "Bob", score: 2000 }, { isInBottomThreeOfLobby: true }),
      createPost({ playerDisplayName: "Chris", score: 1800 }, { isInBottomThreeOfLobby: true })
    ], () => 0);

    const embed = payload.embeds?.[0] as Record<string, unknown>;
    const description = String(embed.description);
    expect(description).toContain("se disputent la dernière place. Quelle rivalité !");
    expect(description).toContain("Bob et Chris");
    // vignette neutre (carte) et ligne de remplissage pour la largeur fixe
    expect(String((embed.thumbnail as Record<string, unknown>).url)).toContain("/maps/");
    expect(description).toContain("⠀");

    const soloPayload = formatMatchSummary([
      createPost({ playerDisplayName: "Alice", score: 6000 }),
      createPost({ playerDisplayName: "Bob", score: 2000 }, { isInBottomThreeOfLobby: true })
    ], () => 0);
    const soloDescription = String((soloPayload.embeds?.[0] as Record<string, unknown>).description ?? "");
    expect(soloDescription).not.toContain("dernière place");
  });
});

describe("punchlines", () => {
  // Variante 0 forcee : les assertions portent sur la phrase historique de chaque event.
  const firstVariant = () => 0;
  const punch = (
    overrides: Partial<MatchSummaryPost> = {},
    highlights: Partial<MatchHighlights> = {}
  ): string[] => getPunchlines(createPost(overrides, highlights), firstVariant);

  it("celebrates aces, carries and heavy fraggers", () => {
    expect(punch({}, { aces: 1 })).toContainEqual(expect.stringContaining("GG pour l'ACE"));
    expect(punch({}, { teamCarryRatio: 1.8 })).toContainEqual(expect.stringContaining("1v9"));
    expect(punch({ didWin: false }, { isTopScoreOfMatch: true }))
      .toContainEqual(expect.stringContaining("porté sa team"));
    expect(punch({ headshots: 20, bodyshots: 20, legshots: 0 }))
      .toContainEqual(expect.stringContaining("sniper"));
    expect(punch({ didWin: true }, { teamComeback: true }))
      .toContainEqual(expect.stringContaining("REMONTADA"));
    expect(punch({}, { aces: 2 }))
      .toContainEqual(expect.stringContaining("2 ACES"));
    expect(punch({ score: 9000, roundsPlayed: 22 }))
      .toContainEqual(expect.stringContaining("smurf"));
    expect(punch({ didWin: true }, { isBottomFragOfMatch: true }))
      .toContainEqual(expect.stringContaining("sac à dos"));
  });

  it("roasts wasted time", () => {
    expect(punch({ didWin: false, gameLengthInMs: 18 * 60_000 }))
      .toContainEqual(expect.stringContaining("pliée en 18 minutes"));
    expect(punch({ gameLengthInMs: 50 * 60_000 }))
      .toContainEqual(expect.stringContaining("50 minutes de match"));
  });

  it("roasts bad games with the right thresholds", () => {
    const ghost = punch({ score: 1500, damageDealt: 900 });
    expect(ghost).toContainEqual(expect.stringContaining("👻"));
    expect(ghost.some((message) => message.includes("📉"))).toBe(false);

    const lowDamage = punch({ score: 2500, damageDealt: 1200 });
    expect(lowDamage).toContainEqual(expect.stringContaining("📉"));

    expect(punch({ headshots: 3, bodyshots: 30, legshots: 8 }))
      .toContainEqual(expect.stringContaining("rotules"));
    expect(punch({}, { isDuelist: true, isBottomFragOfMatch: true }))
      .toContainEqual(expect.stringContaining("duelliste"));
    expect(punch({ didWin: false }, { teamChoked: true }))
      .toContainEqual(expect.stringContaining("choke"));
    expect(punch({}, { isMostDeathsInMatch: true }))
      .toContainEqual(expect.stringContaining("plus de temps mort"));
    expect(punch({}, { firstBloods: 0, firstDeaths: 5, isMostFirstDeathsInMatch: true }))
      .toContainEqual(expect.stringContaining("aimant à balles"));
  });

  it("stays silent on an average game and caps the roast at 3 messages", () => {
    expect(punch()).toHaveLength(0);

    const awful = punch(
      { didWin: false, score: 1200, damageDealt: 800, headshots: 1, bodyshots: 20, legshots: 6 },
      { isMostDeathsInMatch: true, isDuelist: true, isBottomFragOfMatch: true }
    );
    expect(awful).toHaveLength(3);
  });

  it("does not judge aim on a handful of bullets", () => {
    expect(punch({ headshots: 4, bodyshots: 4, legshots: 0 })).toHaveLength(0);
    expect(punch({ headshots: 0, bodyshots: 8, legshots: 2 })).toHaveLength(0);
  });

  it("rotates variants but stays deterministic for a given match", () => {
    const post = createPost({}, { aces: 1 });

    // Chaque variante est adressable...
    expect(getPunchlines(post, () => 1)).toContainEqual(expect.stringContaining("nettoyer un round"));
    expect(getPunchlines(post, () => 3)).toContainEqual(expect.stringContaining("Personne n'a survécu"));
    // ...et un index hors bornes est ramene dans la liste.
    expect(getPunchlines(post, () => 99)).toHaveLength(1);

    // Sans picker : choix stable pour un meme match (deux appels identiques).
    expect(getPunchlines(post)).toEqual(getPunchlines(post));

    // Deux joueurs du meme match recoivent la meme variante d'une punchline d'equipe.
    const alice = createPost({ didWin: false, playerDisplayName: "Alice" }, { teamChoked: true });
    const bob = createPost({ didWin: false, playerDisplayName: "Bob" }, { teamChoked: true });
    expect(getPunchlines(alice)).toEqual(getPunchlines(bob));
  });
});

describe("HenrikDevProvider", () => {
  it("reads current rank, RR delta and season record from the HenrikDev MMR payload", async () => {
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
          },
          seasonal: [
            {
              // acte courant place EN PREMIER : l'ordre du tableau ne doit pas compter
              season: { id: "current-season", short: "e11a1" },
              // "wins" exclut les placements ; act_wins liste chaque victoire reelle
              wins: 12,
              games: 20,
              act_wins: Array.from({ length: 14 }, () => ({ id: 12, name: "Gold 1" }))
            },
            {
              season: { id: "old-season", short: "e10a4" },
              wins: 30,
              games: 61
            }
          ]
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
      gameName: "Demo",
      tagLine: "TEST",
      region: "eu",
      puuid: "00000000-0000-0000-0000-000000000000"
    });

    expect(snapshot.rankName).toBe("Platinum 2");
    expect(snapshot.rankingInTier).toBe(60);
    expect(snapshot.lastRrChange).toBe(18);
    // 14 victoires reelles (act_wins) et non les 12 "wins" hors placements
    expect(snapshot.wins).toBe(14);
    expect(snapshot.games).toBe(20);
  });

  it("maps the MMR history to per-match RR changes", async () => {
    const response = {
      status: 200,
      data: {
        history: [
          {
            match_id: "match-9",
            tier: { id: 17, name: "Platinum 3" },
            rr: 12,
            last_change: 21,
            date: "2026-07-05T20:00:00.000Z"
          },
          {
            match_id: "match-8",
            tier: { id: 16, name: "Platinum 2" },
            rr: 91,
            last_change: -9,
            date: "2026-07-05T19:00:00.000Z"
          },
          {
            not_a_match: true
          }
        ]
      }
    };

    const provider = new HenrikDevProvider({
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    });

    const changes = await provider.getMatchRrChanges({
      gameName: "Demo",
      tagLine: "TEST",
      region: "eu",
      puuid: "00000000-0000-0000-0000-000000000000"
    });

    expect(changes.size).toBe(2);
    expect(changes.get("match-9")).toEqual({
      matchId: "match-9",
      startedAt: "2026-07-05T20:00:00.000Z",
      rrChange: 21,
      rrAfter: 12,
      rankTierAfter: 17,
      rankNameAfter: "Platinum 3"
    });
    expect(changes.get("match-8")?.rrChange).toBe(-9);
  });

  it("waits for the rate limit window announced by a 429 and then succeeds", async () => {
    let calls = 0;
    const provider = new HenrikDevProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ errors: [{ status: 429 }] }), {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "0"
            }
          });
        }

        return new Response(JSON.stringify({
          status: 200,
          data: {
            current: {
              tier: { id: 16, name: "Platinum 2" },
              rr: 60,
              last_change: 18
            },
            seasonal: []
          }
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }
    });

    const snapshot = await provider.getPlayerSnapshot({
      gameName: "Demo",
      tagLine: "TEST",
      region: "eu",
      puuid: "00000000-0000-0000-0000-000000000000"
    });

    expect(calls).toBe(2);
    expect(snapshot.rankName).toBe("Platinum 2");
  }, 10000);

  it("computes highlights from the full v4 match payload (rounds, kills, lobby stats)", async () => {
    const apiMatch = {
      metadata: {
        match_id: "match-full",
        started_at: "2026-07-05T20:00:00.000Z",
        game_length_in_ms: 2400000,
        queue: { name: "Competitive" },
        map: { id: "map-bind-uuid", name: "Bind" },
        season: { short: "e11a4" }
      },
      players: [
        {
          puuid: "p1",
          team_id: "Blue",
          agent: { id: "agent-jett", name: "Jett" },
          stats: {
            kills: 5, deaths: 20, assists: 1,
            headshots: 2, bodyshots: 20, legshots: 8,
            score: 1200,
            damage: { dealt: 1100, received: 3000 }
          }
        },
        {
          puuid: "p2",
          team_id: "Blue",
          agent: { id: "agent-sova", name: "Sova" },
          stats: {
            kills: 25, deaths: 10, assists: 5,
            headshots: 10, bodyshots: 20, legshots: 1,
            score: 6000,
            damage: { dealt: 4000, received: 2000 }
          }
        },
        {
          puuid: "e1",
          team_id: "Red",
          agent: { id: "agent-omen", name: "Omen" },
          stats: {
            kills: 15, deaths: 15, assists: 3,
            headshots: 5, bodyshots: 20, legshots: 2,
            score: 3500,
            damage: { dealt: 3000, received: 2500 }
          }
        }
      ],
      teams: [
        { team_id: "Blue", won: false, rounds: { won: 11, lost: 13 } },
        { team_id: "Red", won: true, rounds: { won: 13, lost: 11 } }
      ],
      rounds: [
        ...Array.from({ length: 11 }, (_, index) => ({ id: index + 1, winning_team: "Blue" })),
        ...Array.from({ length: 13 }, (_, index) => ({ id: index + 12, winning_team: "Red" }))
      ],
      kills: [
        ...Array.from({ length: 5 }, (_, index) => ({
          round: 1,
          time_in_round_in_ms: 1000 + index * 500,
          killer: { puuid: "p2", team: "Blue" },
          victim: { puuid: "e1", team: "Red" }
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          round: index + 2,
          time_in_round_in_ms: 700,
          killer: { puuid: "e1", team: "Red" },
          victim: { puuid: "p1", team: "Blue" }
        }))
      ]
    };

    const provider = new HenrikDevProvider({
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify({ status: 200, data: [apiMatch] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      })
    });

    const identity = { gameName: "A", tagLine: "B", region: "eu" as const };
    const [forP1] = await provider.getRecentCompetitiveMatches({ ...identity, puuid: "p1" }, 1);
    expect(forP1?.roundsPlayed).toBe(24);
    expect(forP1?.damageDealt).toBe(1100);
    expect(forP1?.mapImageUrl).toBe("https://media.valorant-api.com/maps/map-bind-uuid/splash.png");
    // lobby de 3 joueurs seulement : la garde "au moins 8 joueurs" bloque le bottom 3
    expect(forP1?.highlights.isInBottomThreeOfLobby).toBe(false);
    expect(forP1?.highlights.teamChoked).toBe(true);
    expect(forP1?.highlights.isMostDeathsInMatch).toBe(true);
    expect(forP1?.highlights.isBottomFragOfMatch).toBe(true);
    expect(forP1?.highlights.isDuelist).toBe(true);
    expect(forP1?.highlights.firstBloods).toBe(0);
    expect(forP1?.highlights.firstDeaths).toBe(5);
    expect(forP1?.highlights.isMostFirstDeathsInMatch).toBe(true);
    expect(forP1?.highlights.isTopScoreOfMatch).toBe(false);

    const [forP2] = await provider.getRecentCompetitiveMatches({ ...identity, puuid: "p2" }, 1);
    expect(forP2?.highlights.aces).toBe(1);
    expect(forP2?.highlights.isTopScoreOfMatch).toBe(true);
    expect(forP2?.highlights.isDuelist).toBe(false);
    expect(forP2?.highlights.teamCarryRatio).toBe(5);
    expect(forP2?.highlights.teamComeback).toBe(false);

    // Red etait mene 0-11 (l'adversaire avait un "big lead") et a gagne : remontada.
    const [forE1] = await provider.getRecentCompetitiveMatches({ ...identity, puuid: "e1" }, 1);
    expect(forE1?.highlights.teamComeback).toBe(true);
    expect(forE1?.highlights.teamChoked).toBe(false);
  });
});

describe("weekly recap", () => {
  it("announces that nobody played when there are no stats", async () => {
    const { buildWeeklyRecapPayload } = await import("../src/recap.js");
    const payload = buildWeeklyRecapPayload([]);
    const embed = payload.embeds?.[0] as Record<string, unknown>;
    expect(String(embed.title)).toContain("Cérémonie");
    expect(String(embed.description)).toContain("Personne n'a joué");
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

function createHighlights(overrides: Partial<MatchHighlights> = {}): MatchHighlights {
  return {
    aces: 0,
    firstBloods: 2,
    firstDeaths: 1,
    isMostFirstDeathsInMatch: false,
    isMostDeathsInMatch: false,
    isBottomFragOfMatch: false,
    isTopScoreOfMatch: false,
    isInBottomThreeOfLobby: false,
    teamCarryRatio: 1.1,
    isDuelist: false,
    teamChoked: false,
    teamComeback: false,
    ...overrides
  };
}

function createMatch(matchId: string, startedAt = "2026-06-19T18:00:00.000Z"): MatchSummary {
  return {
    matchId,
    mode: "Competitive",
    mapName: "Ascent",
    mapImageUrl: "https://media.valorant-api.com/maps/test-map/splash.png",
    startedAt,
    seasonShort: "e11a3",
    gameLengthInMs: 1765000,
    agentName: "Sova",
    agentPortraitUrl: "https://media.valorant-api.com/agents/test/displayicon.png",
    teamId: "Blue",
    kills: 20,
    deaths: 15,
    assists: 10,
    headshots: 12,
    bodyshots: 30,
    legshots: 3,
    score: 5300,
    damageDealt: 3500,
    roundsPlayed: 22,
    teamScore: 13,
    opponentScore: 9,
    didWin: true,
    highlights: createHighlights()
  };
}

function createPost(
  overrides: Partial<MatchSummaryPost> = {},
  highlights: Partial<MatchHighlights> = {}
): MatchSummaryPost {
  const base = createMatch("match-post");
  return {
    ...base,
    playerDisplayName: "Demo#EUW",
    rrDelta: null,
    rankTierAfter: null,
    rankNameAfter: null,
    rrAfter: null,
    ...overrides,
    highlights: createHighlights(highlights)
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
