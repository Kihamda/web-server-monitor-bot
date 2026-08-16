import { DurableObject } from "cloudflare:workers";
import { ExternalRequestBudget, MAX_EXTERNAL_SUBREQUESTS } from "./budget";
import { sendDownAlert } from "./discord";
import { probeEndpoint } from "./monitoring";
import type {
  AddResult,
  Env,
  InternalResult,
  ListResult,
  MonitorRow,
  PendingStage,
  SchedulerStateRow,
} from "./types";

const SCHEDULER_NAME = "global";
export const MAX_PER_GUILD = 10;
export const MAX_GLOBAL_MONITORS = 1_000;

const FIRST_ALARM_DELAY_MS = 60_000;
const CONTINUATION_DELAY_MS = 5_000;
const CYCLE_PERIOD_MS = 22 * 60 * 60 * 1_000;
const MIN_NEXT_CYCLE_DELAY_MS = 60_000;
const CANDIDATE_READ_LIMIT = MAX_EXTERNAL_SUBREQUESTS + 1;

type ProcessResult =
  | { kind: "complete" }
  | { kind: "partial"; stage: PendingStage }
  | { kind: "retry_alert"; retryAfterMs: number };

interface AddPayload {
  guildId: string;
  channelId: string;
  name: string;
  url: string;
}

interface RemovePayload {
  guildId: string;
  name: string;
}

interface MutableRunState {
  cursorId: number;
  pendingMonitorId: number | null;
  pendingStage: PendingStage | null;
  cycleStartedAt: number;
}

export function schedulerStub(env: Env) {
  const id = env.MONITOR_SCHEDULER.idFromName(SCHEDULER_NAME);
  return env.MONITOR_SCHEDULER.get(id);
}

export class MonitorScheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  private ensureSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS monitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        down_notified INTEGER NOT NULL DEFAULT 0 CHECK (down_notified IN (0, 1)),
        UNIQUE(guild_id, name),
        UNIQUE(guild_id, url)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS monitors_guild_id_idx
      ON monitors(guild_id, id)
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor_id INTEGER NOT NULL DEFAULT 0,
        pending_monitor_id INTEGER,
        pending_stage TEXT CHECK (pending_stage IN ('confirm', 'notify') OR pending_stage IS NULL),
        cycle_started_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO scheduler_state
        (singleton, cursor_id, pending_monitor_id, pending_stage, cycle_started_at)
      VALUES (1, 0, NULL, NULL, 0)
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/add") {
      return Response.json(await this.add((await request.json()) as AddPayload));
    }
    if (request.method === "GET" && url.pathname === "/list") {
      return Response.json(this.list(url.searchParams.get("guildId") ?? ""));
    }
    if (request.method === "POST" && url.pathname === "/remove") {
      return Response.json(await this.remove((await request.json()) as RemovePayload));
    }

    return new Response("Not Found", { status: 404 });
  }

  private async add(payload: AddPayload): Promise<AddResult> {
    const guildCount = firstValue<{ count: number }>(
      this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM monitors WHERE guild_id = ?",
        payload.guildId,
      ),
    )?.count ?? 0;
    if (guildCount >= MAX_PER_GUILD) {
      return { ok: false, error: `このサーバーでは最大${MAX_PER_GUILD}件まで登録できます。` };
    }

    const globalCount = firstValue<{ count: number }>(
      this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM monitors"),
    )?.count ?? 0;
    if (globalCount >= MAX_GLOBAL_MONITORS) {
      return { ok: false, error: "Bot全体の監視上限に達しています。" };
    }

    const duplicate = firstValue<{ id: number }>(
      this.ctx.storage.sql.exec(
        `SELECT id FROM monitors
          WHERE guild_id = ? AND (name = ? OR url = ?)
          LIMIT 1`,
        payload.guildId,
        payload.name,
        payload.url,
      ),
    );
    if (duplicate) {
      return { ok: false, error: "同じ名前またはURLがすでに登録されています。" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO monitors (guild_id, channel_id, name, url, down_notified)
       VALUES (?, ?, ?, ?, 0)`,
      payload.guildId,
      payload.channelId,
      payload.name,
      payload.url,
    );

    const row = firstValue<{ id: number }>(
      this.ctx.storage.sql.exec("SELECT last_insert_rowid() AS id"),
    );

    await this.ensureAlarm();
    return row?.id === undefined ? { ok: true } : { ok: true, id: row.id };
  }

  private list(guildId: string): ListResult {
    const monitors = Array.from(
      this.ctx.storage.sql.exec<MonitorRow>(
        `SELECT id, guild_id, channel_id, name, url, down_notified
           FROM monitors
          WHERE guild_id = ?
          ORDER BY id`,
        guildId,
      ),
    ).map(({ id, name, url }) => ({ id, name, url }));

    return { ok: true, monitors };
  }

  private async remove(payload: RemovePayload): Promise<InternalResult> {
    const existing = firstValue<{ id: number }>(
      this.ctx.storage.sql.exec(
        "SELECT id FROM monitors WHERE guild_id = ? AND name = ? LIMIT 1",
        payload.guildId,
        payload.name,
      ),
    );
    if (!existing) return { ok: false, error: "その名前の監視先はありません。" };

    this.ctx.storage.sql.exec("DELETE FROM monitors WHERE id = ?", existing.id);

    const remaining = firstValue<{ count: number }>(
      this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM monitors"),
    )?.count ?? 0;

    if (remaining === 0) {
      this.resetSchedulerState();
      await this.ctx.storage.deleteAlarm();
    }

    return { ok: true };
  }

  async alarm(): Promise<void> {
    const invocationStartedAt = Date.now();
    const stored = this.readSchedulerState();
    const state: MutableRunState = {
      cursorId: stored.cursor_id,
      pendingMonitorId: stored.pending_monitor_id,
      pendingStage: stored.pending_stage,
      cycleStartedAt: stored.cycle_started_at || invocationStartedAt,
    };

    const budget = new ExternalRequestBudget();

    // A monitor may have consumed the last subrequest in the previous invocation between
    // primary probe -> confirmation -> Discord alert. Finish that exact stage first.
    if (state.pendingMonitorId !== null && state.pendingStage !== null) {
      const pendingId = state.pendingMonitorId;
      const monitor = this.getMonitor(pendingId);

      if (!monitor) {
        state.cursorId = Math.max(state.cursorId, pendingId);
        state.pendingMonitorId = null;
        state.pendingStage = null;
      } else {
        const result = await this.resumeMonitor(monitor, state.pendingStage, budget);

        if (result.kind === "partial") {
          state.pendingStage = result.stage;
          await this.persistAndContinue(state, CONTINUATION_DELAY_MS);
          return;
        }
        if (result.kind === "retry_alert") {
          state.pendingStage = "notify";
          await this.persistAndContinue(state, result.retryAfterMs);
          return;
        }

        state.cursorId = monitor.id;
        state.pendingMonitorId = null;
        state.pendingStage = null;
      }
    }

    const candidates = this.readCandidates(state.cursorId);
    let nextUnfinishedIndex = candidates.length;

    for (let index = 0; index < candidates.length; index += 1) {
      const monitor = candidates[index];
      if (!monitor) continue;

      if (budget.remaining === 0) {
        nextUnfinishedIndex = index;
        break;
      }

      const result = await this.processFreshMonitor(monitor, budget);

      if (result.kind === "partial") {
        state.pendingMonitorId = monitor.id;
        state.pendingStage = result.stage;
        nextUnfinishedIndex = index;
        break;
      }

      if (result.kind === "retry_alert") {
        state.pendingMonitorId = monitor.id;
        state.pendingStage = "notify";
        await this.persistAndContinue(state, result.retryAfterMs);
        return;
      }

      state.cursorId = monitor.id;
      nextUnfinishedIndex = index + 1;
    }

    const hasMore =
      state.pendingMonitorId !== null ||
      nextUnfinishedIndex < candidates.length ||
      candidates.length === CANDIDATE_READ_LIMIT;

    if (hasMore) {
      await this.persistAndContinue(state, CONTINUATION_DELAY_MS);
      return;
    }

    // No more monitors in this cycle. Small installations that fit in one invocation never
    // need a scheduler-state write; only setAlarm() is charged as the recurring write.
    if (
      stored.cursor_id !== 0 ||
      stored.pending_monitor_id !== null ||
      stored.pending_stage !== null ||
      stored.cycle_started_at !== 0
    ) {
      this.resetSchedulerState();
    }

    const monitorCount = firstValue<{ count: number }>(
      this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM monitors"),
    )?.count ?? 0;

    if (monitorCount === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const nextCycleAt = Math.max(
      Date.now() + MIN_NEXT_CYCLE_DELAY_MS,
      state.cycleStartedAt + CYCLE_PERIOD_MS,
    );
    await this.ctx.storage.setAlarm(nextCycleAt);
  }

  private async processFreshMonitor(
    monitor: MonitorRow,
    budget: ExternalRequestBudget,
  ): Promise<ProcessResult> {
    if (!budget.tryTake()) return { kind: "partial", stage: "confirm" };

    const first = await probeEndpoint(monitor.url, "HEAD");
    if (first.alive) {
      this.clearDownStateIfNeeded(monitor);
      return { kind: "complete" };
    }

    if (!budget.tryTake()) return { kind: "partial", stage: "confirm" };

    const confirmation = await probeEndpoint(monitor.url, "GET");
    if (confirmation.alive) {
      this.clearDownStateIfNeeded(monitor);
      return { kind: "complete" };
    }

    if (monitor.down_notified === 1) return { kind: "complete" };

    if (!budget.tryTake()) return { kind: "partial", stage: "notify" };
    return this.deliverDownAlert(monitor);
  }

  private async resumeMonitor(
    monitor: MonitorRow,
    stage: PendingStage,
    budget: ExternalRequestBudget,
  ): Promise<ProcessResult> {
    if (stage === "confirm") {
      if (!budget.tryTake()) return { kind: "partial", stage: "confirm" };

      const confirmation = await probeEndpoint(monitor.url, "GET");
      if (confirmation.alive) {
        this.clearDownStateIfNeeded(monitor);
        return { kind: "complete" };
      }

      if (monitor.down_notified === 1) return { kind: "complete" };
      if (!budget.tryTake()) return { kind: "partial", stage: "notify" };
      return this.deliverDownAlert(monitor);
    }

    if (!budget.tryTake()) return { kind: "partial", stage: "notify" };
    return this.deliverDownAlert(monitor);
  }

  private async deliverDownAlert(monitor: MonitorRow): Promise<ProcessResult> {
    // The monitor might have been removed while an earlier external request was in flight.
    // Avoid posting an obsolete alert.
    if (!this.getMonitor(monitor.id)) return { kind: "complete" };

    const alert = await sendDownAlert(
      this.env.DISCORD_TOKEN,
      monitor.channel_id,
      monitor.id,
      monitor.name,
      monitor.url,
    );

    if (alert.kind === "sent") {
      this.ctx.storage.sql.exec(
        "UPDATE monitors SET down_notified = 1 WHERE id = ? AND down_notified = 0",
        monitor.id,
      );
      return { kind: "complete" };
    }

    if (alert.kind === "retryable") {
      // Notification delivery is more important than filling the remaining budget. Stop only
      // for Discord/network infrastructure failure so a single pending action is sufficient.
      return { kind: "retry_alert", retryAfterMs: alert.retryAfterMs };
    }

    console.error(`Discord alert permanently failed with HTTP ${alert.status}`);
    // Leave down_notified=0. If the endpoint is still down next cycle, delivery is attempted again.
    return { kind: "complete" };
  }

  private clearDownStateIfNeeded(monitor: MonitorRow): void {
    if (monitor.down_notified !== 1) return;
    this.ctx.storage.sql.exec(
      "UPDATE monitors SET down_notified = 0 WHERE id = ? AND down_notified = 1",
      monitor.id,
    );
  }

  private readCandidates(cursorId: number): MonitorRow[] {
    return Array.from(
      this.ctx.storage.sql.exec<MonitorRow>(
        `SELECT id, guild_id, channel_id, name, url, down_notified
           FROM monitors
          WHERE id > ?
          ORDER BY id
          LIMIT ?`,
        cursorId,
        CANDIDATE_READ_LIMIT,
      ),
    );
  }

  private getMonitor(id: number): MonitorRow | undefined {
    return firstValue(
      this.ctx.storage.sql.exec<MonitorRow>(
        `SELECT id, guild_id, channel_id, name, url, down_notified
           FROM monitors
          WHERE id = ?
          LIMIT 1`,
        id,
      ),
    );
  }

  private readSchedulerState(): SchedulerStateRow {
    return (
      firstValue(
        this.ctx.storage.sql.exec<SchedulerStateRow>(
          `SELECT cursor_id, pending_monitor_id, pending_stage, cycle_started_at
             FROM scheduler_state
            WHERE singleton = 1`,
        ),
      ) ?? {
        cursor_id: 0,
        pending_monitor_id: null,
        pending_stage: null,
        cycle_started_at: 0,
      }
    );
  }

  private persistSchedulerState(state: MutableRunState): void {
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_state
          SET cursor_id = ?,
              pending_monitor_id = ?,
              pending_stage = ?,
              cycle_started_at = ?
        WHERE singleton = 1`,
      state.cursorId,
      state.pendingMonitorId,
      state.pendingStage,
      state.cycleStartedAt,
    );
  }

  private resetSchedulerState(): void {
    this.ctx.storage.sql.exec(
      `UPDATE scheduler_state
          SET cursor_id = 0,
              pending_monitor_id = NULL,
              pending_stage = NULL,
              cycle_started_at = 0
        WHERE singleton = 1`,
    );
  }

  private async persistAndContinue(state: MutableRunState, delayMs: number): Promise<void> {
    const monitorCount = firstValue<{ count: number }>(
      this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM monitors"),
    )?.count ?? 0;
    if (monitorCount === 0) {
      // A remove command can delete the final monitor while an external probe is in flight.
      // Do not recreate an Alarm after remove() has cleared the scheduler state.
      await this.ctx.storage.deleteAlarm();
      return;
    }

    this.persistSchedulerState(state);
    await this.ctx.storage.setAlarm(Date.now() + Math.max(delayMs, 1_000));
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FIRST_ALARM_DELAY_MS);
    }
  }
}

function firstValue<T extends Record<string, unknown>>(rows: Iterable<T>): T | undefined {
  for (const row of rows) return row;
  return undefined;
}
