import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // UI kit tests render components to static HTML (PIN-97); tsconfig
  // keeps "jsx": "preserve" for Next, so vitest compiles JSX itself.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
