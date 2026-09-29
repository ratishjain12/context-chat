import { defineConfig } from "vitest/config"

// Separate from vite.config.ts so the Cloudflare plugin (which boots a
// workerd dev server) isn't loaded for plain unit tests.
export default defineConfig({
  test: {
    include: ["worker/**/*.test.ts", "shared/**/*.test.ts"],
  },
})
