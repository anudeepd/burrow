import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Unit/integration tests (`bun run test`).
 *
 * - happy-dom is the default environment (components, DOM attributes, the parity contract); a spec that must not run in a
 *   browser-like environment starts with `// @vitest-environment node`.
 * - schemas run in STRICT mode via `vitest.setup.ts`, so a test fixture with an unknown key fails loudly — that is the
 *   P1 "no key left behind" gate in miniature.
 * - e2e specs (`e2e/**`) are Playwright's; vitest must not pick them up.
 */
export default defineConfig({
  plugins: [viteReact()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "happy-dom",
    pool: "threads",
    maxWorkers: 2,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**", "dev/**"],
    setupFiles: ["./vitest.setup.ts"],
    restoreMocks: true,
    reporters: ["default"],
    coverage: {
      provider: "istanbul",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,spec}.{ts,tsx}", "src/**/__tests__/**", "src/**/*.d.ts", "src/**/*.gen.ts"],
    },
  },
});
