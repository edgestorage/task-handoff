import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runtimePackages } from "./runtime-packages.config.mjs";

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys({
  ...(packageJson.dependencies || {}),
  ...(packageJson.peerDependencies || {}),
});

const isNodeBuiltin = (id) => id.startsWith("node:");
const isExternal = (id) => isNodeBuiltin(id) || external.some((pkg) => id === pkg || id.startsWith(`${pkg}/`));

const externalFrom = (dependencies) => {
  const names = Object.keys(dependencies);
  return (id) => isNodeBuiltin(id) || names.some((pkg) => id === pkg || id.startsWith(`${pkg}/`));
};

const plugins = [
  {
    name: "json-modules",
    transform(source, id) {
      if (!id.endsWith(".json")) return null;
      const value = JSON.parse(source);
      const named = Object.entries(value)
        .filter(([key]) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) && key !== "default")
        .map(([key, entry]) => `export const ${key} = ${JSON.stringify(entry)};`)
        .join("\n");
      return `${named}\nexport default ${JSON.stringify(value)};`;
    },
  },
  nodeResolve({ preferBuiltins: true }),
  typescript({
    tsconfig: "./tsconfig.json",
    noEmitOnError: false,
    compilerOptions: {
      rewriteRelativeImportExtensions: true,
    },
  }),
  commonjs({ transformMixedEsModules: true, extensions: [".cjs", ".cts", ".js", ".ts"] }),
];

const runtimeDependencyEntrypoints = {
  name: "runtime-dependency-entrypoints",
  resolveId(source) {
    // @xterm/headless@6.0.0 publishes a Node-compatible CommonJS entrypoint,
    // but its `module` field points at a file that is absent from the package.
    // Resolve the authoritative `main` entry so Rollup includes it instead of
    // silently leaving a runtime require in the portable controlled instance.
    if (source === "@xterm/headless") return require.resolve(source);
    return null;
  },
};

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
      "chat-render": "packages/core/src/core/chat-render.ts",
      diagnostics: "packages/core/src/core/diagnostics.ts",
      persistence: "packages/core/src/core/persistence.ts",
      transcript: "packages/core/src/core/transcript.ts",
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
];

const controlledInstanceBuild = [
  {
    input: {
      "controlled-instance-cli": "apps/controlled-instance-image/src/cli.ts",
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
  const onwarn = (warning, warn) => {
    if (warning.code === "UNRESOLVED_IMPORT") {
      throw new Error(`Runtime package ${name} contains an unresolved import: ${warning.source || warning.message}`);
    }
    warn(warning);
  };
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
      onwarn,
      plugins: [cleanRuntimeDir(outputDir), runtimeDependencyEntrypoints, ...plugins, runtimeMinifier()],
    },
  ];
  if (definition.updateWorkerInput) {
    builds.push({
      input: definition.updateWorkerInput,
      output: {
        file: `${outputDir}/${definition.updateWorkerEntryFile}`,
        format: "cjs",
        exports: "auto",
        inlineDynamicImports: true,
      },
      external: externalFrom(definition.dependencies),
      onwarn,
      plugins: [cleanRuntimeDir(outputDir), runtimeDependencyEntrypoints, ...plugins, runtimeMinifier()],
    });
  }
  for (const standalone of definition.standaloneInputs || []) {
    builds.push({
      input: standalone.input,
      output: {
        file: `${outputDir}/${standalone.entryFile}`,
        format: "cjs",
        exports: "auto",
        inlineDynamicImports: true,
      },
      external: isNodeBuiltin,
      onwarn,
      plugins: [cleanRuntimeDir(outputDir), runtimeDependencyEntrypoints, ...plugins, runtimeMinifier()],
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
