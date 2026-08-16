export interface DurableObjectIdLike {}

export interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface Env {
  MONITOR_SCHEDULER: DurableObjectNamespaceLike;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_TOKEN: string;
}

export interface Interaction {
  type: number;
  guild_id?: string;
  channel_id?: string;
  app_permissions?: string;
  member?: {
    permissions?: string;
    user?: { id: string };
  };
  data?: {
    name?: string;
    options?: InteractionOption[];
  };
}

export interface InteractionOption {
  name: string;
  type: number;
  value?: string;
  options?: InteractionOption[];
}

export interface MonitorRow {
  [key: string]: string | number | null;
  id: number;
  guild_id: string;
  channel_id: string;
  name: string;
  url: string;
  down_notified: number;
}

export type PendingStage = "confirm" | "notify";

export interface SchedulerStateRow {
  [key: string]: string | number | null;
  cursor_id: number;
  pending_monitor_id: number | null;
  pending_stage: PendingStage | null;
  cycle_started_at: number;
}

export interface InternalResult {
  ok: boolean;
  error?: string;
}

export interface AddResult extends InternalResult {
  id?: number;
}

export interface ListResult extends InternalResult {
  monitors?: Array<Pick<MonitorRow, "id" | "name" | "url">>;
}
