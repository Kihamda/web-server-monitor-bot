import { interactionMessage } from "./discord";
import { MAX_PER_GUILD, schedulerStub } from "./scheduler";
import { validateMonitorUrl } from "./security";
import type { AddResult, Env, Interaction, InteractionOption, ListResult, InternalResult } from "./types";

const SEND_MESSAGES = 1n << 11n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;

function subcommand(interaction: Interaction): InteractionOption | undefined {
  return interaction.data?.options?.[0];
}

function value(options: InteractionOption[] | undefined, name: string): string | undefined {
  return options?.find((option) => option.name === name)?.value;
}

function hasPermission(raw: string | undefined, permission: bigint): boolean {
  if (!raw) return false;
  try {
    return (BigInt(raw) & permission) !== 0n;
  } catch {
    return false;
  }
}

function canManageGuild(interaction: Interaction): boolean {
  const raw = interaction.member?.permissions;
  const administrator = 1n << 3n;
  const manageGuild = 1n << 5n;
  return hasPermission(raw, administrator) || hasPermission(raw, manageGuild);
}

function botCanPostHere(interaction: Interaction): boolean {
  const raw = interaction.app_permissions;
  return hasPermission(raw, SEND_MESSAGES) || hasPermission(raw, SEND_MESSAGES_IN_THREADS);
}

async function callScheduler<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const response = await schedulerStub(env).fetch(`https://scheduler.internal${path}`, init);
  if (!response.ok) throw new Error(`Scheduler error: ${response.status}`);
  return (await response.json()) as T;
}

export async function handleMonitorCommand(interaction: Interaction, env: Env): Promise<Response> {
  const guildId = interaction.guild_id;
  const channelId = interaction.channel_id;
  if (!guildId || !channelId) return interactionMessage("サーバー内で実行してください。");
  if (!canManageGuild(interaction)) {
    return interactionMessage("このコマンドには「サーバーの管理」権限が必要です。");
  }

  const sub = subcommand(interaction);
  if (!sub) return interactionMessage("サブコマンドがありません。");

  try {
    if (sub.name === "add") {
      if (!botCanPostHere(interaction)) {
        return interactionMessage("このチャンネルへ障害通知を送る権限がBotにありません。");
      }

      const name = value(sub.options, "name")?.trim();
      const rawUrl = value(sub.options, "url")?.trim();
      if (!name || !rawUrl) return interactionMessage("名前とURLが必要です。");
      if (name.length > 80) return interactionMessage("名前は80文字以内にしてください。");

      const url = validateMonitorUrl(rawUrl);
      const result = await callScheduler<AddResult>(env, "/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, channelId, name, url: url.toString() }),
      });
      if (!result.ok) return interactionMessage(result.error ?? "登録できませんでした。");

      return interactionMessage(
        `✅ **${name}** を登録しました。\n<${url.toString()}>\n正常時は通知しません。`,
      );
    }

    if (sub.name === "list") {
      const result = await callScheduler<ListResult>(
        env,
        `/list?guildId=${encodeURIComponent(guildId)}`,
      );
      const monitors = result.monitors ?? [];
      if (monitors.length === 0) return interactionMessage("監視先はまだありません。");

      const lines = monitors.map(
        (monitor, index) => `${index + 1}. **${monitor.name}** — <${monitor.url}>`,
      );
      return interactionMessage(`${lines.join("\n")}\n\n${monitors.length}/${MAX_PER_GUILD}件`);
    }

    if (sub.name === "remove") {
      const name = value(sub.options, "name")?.trim();
      if (!name) return interactionMessage("削除する名前が必要です。");

      const result = await callScheduler<InternalResult>(env, "/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, name }),
      });
      if (!result.ok) return interactionMessage(result.error ?? "削除できませんでした。");
      return interactionMessage(`🗑️ **${name}** を削除しました。`);
    }
  } catch (error) {
    console.error(error);
    return interactionMessage("内部処理に失敗しました。もう一度実行してください。");
  }

  return interactionMessage("不明なサブコマンドです。");
}
