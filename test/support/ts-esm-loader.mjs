import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// apps/cli is a CommonJS package, but its runtime sources are ESM and are
// normally bundled by Rollup. CLI behavior tests execute the source directly.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: fileURLToPath(url),
      }).outputText,
      shortCircuit: true,
    };
  },
});
