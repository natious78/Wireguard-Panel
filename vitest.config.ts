import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    coverage: { reporter: ["text", "html"] },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
