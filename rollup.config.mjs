import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { runtimePackages } from "./runtime-packages.config.mjs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys({
  ...(packageJson.dependencies || {}),
  ...(packageJson.peerDependencies || {}),
});

const isExternal = (id) => external.some((pkg) => id === pkg || id.startsWith(`${pkg}/`));

const externalFrom = (dependencies) => {
  const names = Object.keys(dependencies);
  return (id) => names.some((pkg) => id === pkg || id.startsWith(`${pkg}/`));
};

const plugins = [
  nodeResolve({ preferBuiltins: true }),
  typescript({
    tsconfig: "./tsconfig.json",
    noEmitOnError: false,
    compilerOptions: {
      rewriteRelativeImportExtensions: true,
    },
  }),
  commonjs({ transformMixedEsModules: true }),
];

let cleaned = false;
const cleanDist = {
  name: "clean-dist",
  buildStart() {
    if (!cleaned) {
      cleaned = true;
      rmSync("dist", { recursive: true, force: true });
    }
  },
};

const legacyBuild = [
  {
    input: {
      cli: "apps/cli/src/index.ts",
      chat: "packages/core/src/core/chat.ts",
      "chat-render": "packages/core/src/core/chat-render.ts",
      config: "packages/core/src/core/config.ts",
      diagnostics: "packages/core/src/core/diagnostics.ts",
      duration: "packages/core/src/core/duration.ts",
      persistence: "packages/core/src/core/persistence.ts",
      progress: "packages/core/src/core/progress.ts",
      protocol: "packages/core/src/core/protocol.ts",
      text: "packages/core/src/core/text.ts",
      "codex-approval-hook": "apps/cli/src/hooks/codex-approval.ts",
      "claude-hook-install": "apps/cli/src/hooks/claude-install.ts",
      "codex-hook-install": "apps/cli/src/hooks/codex-install.ts",
      "mcp-install": "apps/cli/src/hooks/mcp-install.ts",
      "unified-install": "apps/cli/src/hooks/unified-install.ts",
      mcp: "apps/cli/src/mcp/index.ts",
      receiver: "packages/receiver-worker/src/receiver-entry.ts",
      sender: "packages/protocol/src/sender.ts",
      socket: "packages/core/src/core/socket.ts",
      "telegram-bridge": "packages/receiver-worker/src/integrations/telegram.ts",
      transcript: "packages/core/src/core/transcript.ts",
      ui: "packages/terminal-ui/src/index.ts",
      web: "packages/controlled-instance/src/web/server.ts",
      "wechat-bridge": "packages/receiver-worker/src/integrations/wechat.ts",
    },
    output: {
      dir: "dist",
      format: "cjs",
      exports: "auto",
      entryFileNames: "[name].js",
    },
    external: isExternal,
    plugins: [cleanDist, ...plugins],
  },
  {
    input: "packages/receiver-worker/src/app.ts",
    output: {
      file: "dist/receiver-ink.mjs",
      format: "esm",
      inlineDynamicImports: true,
    },
    external: isExternal,
    plugins,
  },
];

const controlledInstanceBuild = [
  {
    input: {
      "controlled-instance-cli": "apps/controlled-instance-image/src/cli.ts",
      receiver: "packages/receiver-worker/src/receiver-entry.ts",
      web: "packages/controlled-instance/src/web/server.ts",
    },
    output: {
      dir: "dist",
      format: "cjs",
      exports: "auto",
      entryFileNames: "[name].js",
    },
    external: isExternal,
    plugins: [cleanDist, ...plugins],
  },
  {
    input: "packages/receiver-worker/src/app.ts",
    output: {
      file: "dist/receiver-ink.mjs",
      format: "esm",
      inlineDynamicImports: true,
    },
    external: isExternal,
    plugins,
  },
];

const cleanedRuntimeDirs = new Set();

function cleanRuntimeDir(directory) {
  return {
    name: `clean-runtime-dir-${directory}`,
    buildStart() {
      if (!cleanedRuntimeDirs.has(directory)) {
        cleanedRuntimeDirs.add(directory);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

function runtimeMinifier() {
  return terser({
    compress: {
      passes: 2,
    },
    format: {
      comments: false,
    },
    mangle: {
      toplevel: true,
    },
  });
}

function runtimeBuild(name, definition) {
  const outputDir = `dist/runtime-packages/${name}`;
  const builds = [
    {
      input: definition.input,
      output: {
        file: `${outputDir}/${definition.entryFile}`,
        format: "cjs",
        exports: "auto",
        inlineDynamicImports: true,
      },
      external: externalFrom(definition.dependencies),
      plugins: [cleanRuntimeDir(outputDir), ...plugins, runtimeMinifier()],
    },
  ];
  if (definition.receiverInkEntry) {
    builds.push({
      input: definition.receiverInkEntry,
      output: {
        file: `${outputDir}/receiver-ink.mjs`,
        format: "esm",
        inlineDynamicImports: true,
      },
      external: externalFrom(definition.dependencies),
      plugins: [...plugins, runtimeMinifier()],
    });
  }
  return builds;
}

const requestedRuntimePackage = process.env.TASK_HANDOFF_RUNTIME_PACKAGE;
const selectedRuntimePackages = requestedRuntimePackage
  ? Object.entries(runtimePackages).filter(([name]) => name === requestedRuntimePackage)
  : Object.entries(runtimePackages);
if (requestedRuntimePackage && selectedRuntimePackages.length === 0) {
  throw new Error(`Unknown TASK_HANDOFF_RUNTIME_PACKAGE: ${requestedRuntimePackage}`);
}
const runtimePackageBuild = selectedRuntimePackages
  .filter(([, definition]) => definition.input)
  .flatMap(([name, definition]) => runtimeBuild(name, definition));

export default process.env.TASK_HANDOFF_ROLLUP_TARGET === "controlled-instance"
  ? controlledInstanceBuild
  : process.env.TASK_HANDOFF_ROLLUP_TARGET === "runtime-packages"
    ? runtimePackageBuild
    : legacyBuild;
