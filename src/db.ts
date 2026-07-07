import { createClient, type Client, type InStatement, type ResultSet } from "@libsql/client/node";
import type { LeaderboardEntry, MatchStatRecord, PlayerSnapshot, PlayerState, Region, TrackedPlayer } from "./types.js";

interface PlayerRow {
  id: number;
  game_name: string;
  tag_line: string;
  region: Region;
  puuid: string;
  display_name: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface PlayerStateRow {
  tracked_player_id: number;
  rank_tier: number | null;
  rank_name: string | null;
  ranking_in_tier: number | null;
  wins: number | null;
  games: number | null;
  win_rate: number | null;
  last_processed_match_id: string | null;
  last_checked_at: string | null;
  updated_at: string;
}

interface PostedMatchRow {
  match_id: string;
}

export class TrackerStore {
  private constructor(private readonly db: Client) {}

  public static async open(options: {
    url: string;
    authToken?: string;
  }): Promise<TrackerStore> {
    const db = createClient(
      options.authToken
        ? {
            url: options.url,
            authToken: options.authToken
          }
        : {
            url: options.url
          }
    );

    const store = new TrackerStore(db);
    await store.migrate();
    return store;
  }

  public close(): void {
    this.db.close();
  }

  public async addTrackedPlayer(input: {
    gameName: string;
    tagLine: string;
    region: Region;
    puuid: string;
    displayName: string | null;
  }): Promise<TrackedPlayer> {
    const now = new Date().toISOString();
    const normalizedDisplayName = normalizeOptionalText(input.displayName);
    const row = await this.getOne<PlayerRow>({
      sql: `
        INSERT INTO tracked_players (
          game_name,
          tag_line,
          region,
          puuid,
          display_name,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(game_name, tag_line, region) DO UPDATE SET
          puuid = excluded.puuid,
          display_name = excluded.display_name,
          enabled = 1,
          updated_at = excluded.updated_at
        RETURNING *
      `,
      args: [input.gameName, input.tagLine, input.region, input.puuid, normalizedDisplayName, now, now]
    });

    await this.ensurePlayerState(row.id);
    return mapPlayer(row);
  }

  public async removeTrackedPlayer(gameName: string, tagLine: string, region: Region): Promise<boolean> {
    const result = await this.db.execute({
      sql: `
        DELETE FROM tracked_players
        WHERE game_name = ? AND tag_line = ? AND region = ?
      `,
      args: [gameName, tagLine, region]
    });

    return Number(result.rowsAffected ?? 0) > 0;
  }

  public async renameTrackedPlayer(gameName: string, tagLine: string, region: Region, displayName: string | null): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.execute({
      sql: `
        UPDATE tracked_players
        SET
          display_name = ?,
          updated_at = ?
        WHERE game_name = ? AND tag_line = ? AND region = ? AND enabled = 1
      `,
      args: [normalizeOptionalText(displayName), now, gameName, tagLine, region]
    });

    return Number(result.rowsAffected ?? 0) > 0;
  }

  public async listTrackedPlayers(): Promise<TrackedPlayer[]> {
    const rows = await this.getMany<PlayerRow>(`
      SELECT *
      FROM tracked_players
      WHERE enabled = 1
      ORDER BY COALESCE(NULLIF(display_name, ''), game_name), tag_line
    `);

    return rows.map(mapPlayer);
  }

  public async getTrackedPlayerByIdentity(gameName: string, tagLine: string, region: Region): Promise<TrackedPlayer | null> {
    const row = await this.getOptional<PlayerRow>({
      sql: `
        SELECT *
        FROM tracked_players
        WHERE game_name = ? AND tag_line = ? AND region = ?
        LIMIT 1
      `,
      args: [gameName, tagLine, region]
    });

    return row ? mapPlayer(row) : null;
  }

  public async getPlayerState(playerId: number): Promise<PlayerState> {
    await this.ensurePlayerState(playerId);
    const row = await this.getOne<PlayerStateRow>({
      sql: `
        SELECT *
        FROM player_state
        WHERE tracked_player_id = ?
        LIMIT 1
      `,
      args: [playerId]
    });

    return mapPlayerState(row);
  }

  public async updatePlayerSnapshot(
    playerId: number,
    snapshot: PlayerSnapshot,
    options: {
      lastProcessedMatchId?: string | null;
      lastCheckedAt?: string;
    } = {}
  ): Promise<PlayerState> {
    await this.ensurePlayerState(playerId);
    const now = new Date().toISOString();
    const row = await this.getOne<PlayerStateRow>({
      sql: `
        UPDATE player_state
        SET
          rank_tier = ?,
          rank_name = ?,
          ranking_in_tier = ?,
          wins = ?,
          games = ?,
          win_rate = ?,
          last_processed_match_id = COALESCE(?, last_processed_match_id),
          last_checked_at = ?,
          updated_at = ?
        WHERE tracked_player_id = ?
        RETURNING *
      `,
      args: [
        snapshot.rankTier,
        snapshot.rankName,
        snapshot.rankingInTier,
        snapshot.wins,
        snapshot.games,
        computeWinRate(snapshot.wins, snapshot.games),
        options.lastProcessedMatchId ?? null,
        options.lastCheckedAt ?? now,
        now,
        playerId
      ]
    });

    return mapPlayerState(row);
  }

  public async updateLastProcessedMatchId(playerId: number, matchId: string): Promise<PlayerState> {
    await this.ensurePlayerState(playerId);
    const now = new Date().toISOString();
    const row = await this.getOne<PlayerStateRow>({
      sql: `
        UPDATE player_state
        SET
          last_processed_match_id = ?,
          last_checked_at = ?,
          updated_at = ?
        WHERE tracked_player_id = ?
        RETURNING *
      `,
      args: [matchId, now, now, playerId]
    });

    return mapPlayerState(row);
  }

  public async getPostedMatchIds(playerId: number, matchIds: string[]): Promise<Set<string>> {
    if (matchIds.length === 0) {
      return new Set();
    }

    const placeholders = matchIds.map(() => "?").join(", ");
    const rows = await this.getMany<PostedMatchRow>({
      sql: `
        SELECT match_id
        FROM posted_matches
        WHERE tracked_player_id = ? AND match_id IN (${placeholders})
      `,
      args: [playerId, ...matchIds]
    });

    return new Set(rows.map((row) => row.match_id));
  }

  public async markMatchPosted(playerId: number, matchId: string, postedAt: string = new Date().toISOString()): Promise<void> {
    await this.db.execute({
      sql: `
        INSERT INTO posted_matches (
          tracked_player_id,
          match_id,
          posted_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(tracked_player_id, match_id) DO NOTHING
      `,
      args: [playerId, matchId, postedAt]
    });
  }

  public async markMatchesPosted(playerId: number, matchIds: string[], postedAt: string = new Date().toISOString()): Promise<void> {
    for (const matchId of matchIds) {
      await this.markMatchPosted(playerId, matchId, postedAt);
    }
  }

  public async recordMatchStats(playerId: number, stats: {
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
  }): Promise<void> {
    await this.db.execute({
      sql: `
        INSERT INTO match_stats (
          tracked_player_id,
          match_id,
          started_at,
          did_win,
          rr_delta,
          kills,
          deaths,
          assists,
          headshots,
          bodyshots,
          legshots,
          score,
          rounds_played,
          damage_dealt,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tracked_player_id, match_id) DO NOTHING
      `,
      args: [
        playerId,
        stats.matchId,
        stats.startedAt,
        stats.didWin === null ? null : stats.didWin ? 1 : 0,
        stats.rrDelta,
        stats.kills,
        stats.deaths,
        stats.assists,
        stats.headshots,
        stats.bodyshots,
        stats.legshots,
        stats.score,
        stats.roundsPlayed,
        stats.damageDealt,
        new Date().toISOString()
      ]
    });
  }

  public async getMatchStatsSince(sinceIso: string): Promise<MatchStatRecord[]> {
    const rows = await this.getMany<Record<string, unknown>>({
      sql: `
        SELECT
          ms.tracked_player_id AS player_id,
          COALESCE(NULLIF(tp.display_name, ''), tp.game_name || '#' || tp.tag_line) AS display_name,
          ms.match_id AS match_id,
          ms.started_at AS started_at,
          ms.did_win AS did_win,
          ms.rr_delta AS rr_delta,
          ms.kills AS kills,
          ms.deaths AS deaths,
          ms.assists AS assists,
          ms.headshots AS headshots,
          ms.bodyshots AS bodyshots,
          ms.legshots AS legshots,
          ms.score AS score,
          ms.rounds_played AS rounds_played,
          ms.damage_dealt AS damage_dealt
        FROM match_stats ms
        INNER JOIN tracked_players tp ON tp.id = ms.tracked_player_id
        WHERE tp.enabled = 1 AND COALESCE(ms.started_at, ms.created_at) >= ?
        ORDER BY COALESCE(ms.started_at, ms.created_at) ASC
      `,
      args: [sinceIso]
    });

    return rows.map((row) => ({
      playerId: Number(row.player_id),
      displayName: String(row.display_name),
      matchId: String(row.match_id),
      startedAt: row.started_at === null ? null : String(row.started_at),
      didWin: row.did_win === null ? null : Number(row.did_win) === 1,
      rrDelta: row.rr_delta === null ? null : Number(row.rr_delta),
      kills: row.kills === null ? null : Number(row.kills),
      deaths: row.deaths === null ? null : Number(row.deaths),
      assists: row.assists === null ? null : Number(row.assists),
      headshots: row.headshots === null ? null : Number(row.headshots),
      bodyshots: row.bodyshots === null ? null : Number(row.bodyshots),
      legshots: row.legshots === null ? null : Number(row.legshots),
      score: row.score === null ? null : Number(row.score),
      roundsPlayed: row.rounds_played === null ? null : Number(row.rounds_played),
      damageDealt: row.damage_dealt === null ? null : Number(row.damage_dealt)
    }));
  }

  public async getLeaderboardEntries(): Promise<LeaderboardEntry[]> {
    const rows = await this.getMany<Record<string, unknown>>(`
      SELECT
        tp.id AS player_id,
        COALESCE(NULLIF(tp.display_name, ''), tp.game_name || '#' || tp.tag_line) AS display_name,
        ps.rank_tier AS rank_tier,
        ps.rank_name AS rank_name,
        ps.ranking_in_tier AS ranking_in_tier,
        ps.wins AS wins,
        ps.games AS games,
        ps.win_rate AS win_rate
      FROM tracked_players tp
      INNER JOIN player_state ps ON ps.tracked_player_id = tp.id
      WHERE tp.enabled = 1
      ORDER BY
        COALESCE(ps.rank_tier, -1) DESC,
        COALESCE(ps.ranking_in_tier, -1) DESC,
        display_name ASC
    `);

    return rows.map((typed) => ({
      playerId: Number(typed.player_id),
      displayName: String(typed.display_name),
      rankTier: typed.rank_tier === null ? null : Number(typed.rank_tier),
      rankName: typed.rank_name === null ? null : String(typed.rank_name),
      rankingInTier: typed.ranking_in_tier === null ? null : Number(typed.ranking_in_tier),
      wins: typed.wins === null ? null : Number(typed.wins),
      games: typed.games === null ? null : Number(typed.games),
      winRate: typed.win_rate === null ? null : Number(typed.win_rate)
    }));
  }

  private async ensurePlayerState(playerId: number): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `
        INSERT INTO player_state (
          tracked_player_id,
          updated_at
        ) VALUES (?, ?)
        ON CONFLICT(tracked_player_id) DO NOTHING
      `,
      args: [playerId, now]
    });
  }

  private async migrate(): Promise<void> {
    await this.db.batch(
      [
        `
          CREATE TABLE IF NOT EXISTS tracked_players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT NOT NULL,
            tag_line TEXT NOT NULL,
            region TEXT NOT NULL,
            puuid TEXT NOT NULL,
            display_name TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(game_name, tag_line, region)
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS player_state (
            tracked_player_id INTEGER PRIMARY KEY,
            rank_tier INTEGER,
            rank_name TEXT,
            ranking_in_tier INTEGER,
            wins INTEGER,
            games INTEGER,
            win_rate REAL,
            last_processed_match_id TEXT,
            last_checked_at TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(tracked_player_id) REFERENCES tracked_players(id) ON DELETE CASCADE
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS posted_matches (
            tracked_player_id INTEGER NOT NULL,
            match_id TEXT NOT NULL,
            posted_at TEXT NOT NULL,
            PRIMARY KEY(tracked_player_id, match_id),
            FOREIGN KEY(tracked_player_id) REFERENCES tracked_players(id) ON DELETE CASCADE
          )
        `,
        `
          CREATE TABLE IF NOT EXISTS match_stats (
            tracked_player_id INTEGER NOT NULL,
            match_id TEXT NOT NULL,
            started_at TEXT,
            did_win INTEGER,
            rr_delta INTEGER,
            kills INTEGER,
            deaths INTEGER,
            assists INTEGER,
            headshots INTEGER,
            bodyshots INTEGER,
            legshots INTEGER,
            score INTEGER,
            rounds_played INTEGER,
            damage_dealt INTEGER,
            created_at TEXT NOT NULL,
            PRIMARY KEY(tracked_player_id, match_id),
            FOREIGN KEY(tracked_player_id) REFERENCES tracked_players(id) ON DELETE CASCADE
          )
        `
      ],
      "write"
    );
  }

  private async getOne<T extends object>(statement: InStatement): Promise<T> {
    const row = await this.getOptional<T>(statement);
    if (!row) {
      throw new Error("Expected one row but query returned none");
    }

    return row;
  }

  private async getOptional<T extends object>(statement: InStatement): Promise<T | null> {
    const result = await this.db.execute(statement);
    const row = result.rows[0];
    return row ? mapRow<T>(row) : null;
  }

  private async getMany<T extends object>(statement: InStatement | string): Promise<T[]> {
    const result = await this.db.execute(statement);
    return result.rows.map((row: ResultSet["rows"][number]) => mapRow<T>(row));
  }
}

function mapPlayer(row: PlayerRow): TrackedPlayer {
  return {
    id: row.id,
    gameName: row.game_name,
    tagLine: row.tag_line,
    region: row.region,
    puuid: row.puuid,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPlayerState(row: PlayerStateRow): PlayerState {
  return {
    trackedPlayerId: row.tracked_player_id,
    rankTier: row.rank_tier,
    rankName: row.rank_name,
    rankingInTier: row.ranking_in_tier,
    wins: row.wins,
    games: row.games,
    winRate: row.win_rate,
    lastProcessedMatchId: row.last_processed_match_id,
    lastCheckedAt: row.last_checked_at,
    updatedAt: row.updated_at
  };
}

function mapRow<T extends object>(row: ResultSet["rows"][number]): T {
  return Object.fromEntries(Object.entries(row)) as T;
}

function computeWinRate(wins: number | null, games: number | null): number | null {
  if (wins === null || games === null || games <= 0) {
    return null;
  }

  return Math.round((wins / games) * 1000) / 10;
}

function normalizeOptionalText(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
