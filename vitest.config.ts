import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// NodeNext-style ".js" specifiers point at ".ts" sources; map them for Vite.
const resolveJsAsTs = {
  name: "resolve-js-as-ts",
  enforce: "pre" as const,
  resolveId(source: string, importer: string | undefined) {
    if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
    const candidate = path.resolve(path.dirname(importer), `${source.slice(0, -3)}.ts`);
    return fs.existsSync(candidate) ? candidate : null;
  }
};

export default defineConfig({
  plugins: [resolveJsAsTs],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
