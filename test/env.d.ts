import type { MonitorScheduler } from "../src/scheduler";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    MONITOR_SCHEDULER: DurableObjectNamespace<MonitorScheduler>;
    DISCORD_PUBLIC_KEY: string;
    DISCORD_TOKEN: string;
  }
}
