import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    include: ["tests/**/*.test.ts"],
    // Hosted logs must carry one line per passed test: the default CI reporter
    // prints no per-file lines for passing files, so the drills would be invisible.
    reporters:
      process.env.GITHUB_ACTIONS === "true" ? ["verbose"] : ["default"],
  },
});
