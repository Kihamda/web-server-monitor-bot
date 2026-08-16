import { handleMonitorCommand } from "./commands";
import { InteractionResponseType, InteractionType } from "./discord";
import { verifyDiscordRequest } from "./security";
import type { Env, Interaction } from "./types";

export { MonitorScheduler } from "./scheduler";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/interactions") {
      return new Response("Not Found", { status: 404 });
    }

    const body = await request.text();
    if (!(await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY, body))) {
      return new Response("invalid request signature", { status: 401 });
    }

    let interaction: Interaction;
    try {
      interaction = JSON.parse(body) as Interaction;
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    if (interaction.type === InteractionType.Ping) {
      return Response.json({ type: InteractionResponseType.Pong });
    }

    if (
      interaction.type === InteractionType.ApplicationCommand &&
      interaction.data?.name === "monitor"
    ) {
      return handleMonitorCommand(interaction, env);
    }

    return new Response("Unsupported interaction", { status: 400 });
  },
};
