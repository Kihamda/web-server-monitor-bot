import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DISCORD_PUBLIC_KEY: "test-public-key",
          DISCORD_TOKEN: "test-token",
        },
      },
    }),
  ],
  test: {
    restoreMocks: true,
  },
});
