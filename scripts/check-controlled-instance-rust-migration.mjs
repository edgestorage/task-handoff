import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryRelativePath = "controlled-instance-rs/docs/migration-inventory.json";
const uiRoot = "packages/controlled-instance-ui";
const approvedAdapterPaths = new Set([
  "controlled-instance-rs/packaging/bin/task-handoff-controlled-instance",
  "controlled-instance-rs/packaging/dist/controlled-instance-cli.js",
]);
const pluginPath = "packages/controlled-instance/src/opencode-story-plugin.ts";
const forbiddenAdapterPackages = [
  "@task-handoff/controlled-instance",
  "@task-handoff/ai-session-runtime",
  "@task-handoff/app-runtime",
  "@task-handoff/core",
];

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function listWorkspacePackages(workspaceRoot) {
  const packages = new Map();
  for (const workspace of ["apps", "packages"]) {
    const workspacePath = path.join(workspaceRoot, workspace);
    if (!fs.existsSync(workspacePath)) continue;
    for (const entry of fs.readdirSync(workspacePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(workspacePath, entry.name, "package.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath);
      packages.set(manifest.name, { dir: path.dirname(manifestPath), manifest });
    }
  }
  return packages;
}

function candidateFiles(base) {
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
    path.join(base, "index.mjs"),
    path.join(base, "index.cjs"),
  ];
}

function resolveFile(base) {
  for (const candidate of candidateFiles(base)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // The next extension or index candidate owns this lookup.
    }
  }
  return undefined;
}

function exportTarget(value) {
  if (typeof value === "string") return value;
  return value?.default ?? value?.types ?? value?.import ?? value?.require;
}

function resolvePackageTarget(packages, packageName, subpath) {
  const workspacePackage = packages.get(packageName);
  if (!workspacePackage) return undefined;
  const exportsField = workspacePackage.manifest.exports;
  let target;
  if (subpath) {
    const key = `./${subpath}`;
    if (typeof exportsField === "string") {
      target = exportsField;
    } else if (exportsField) {
      if (exportsField[key] !== undefined) {
        target = exportTarget(exportsField[key]);
      } else {
        for (const [pattern, value] of Object.entries(exportsField)) {
          const star = pattern.indexOf("*");
          if (star < 0) continue;
          const prefix = pattern.slice(0, star);
          const suffix = pattern.slice(star + 1);
          if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
          const matched = key.slice(prefix.length, key.length - suffix.length);
          target = exportTarget(value)?.replace("*", matched);
          break;
        }
      }
    }
    if (target === undefined) target = `./${subpath}`;
  } else if (typeof exportsField === "string") {
    target = exportsField;
  } else if (exportsField) {
    target = exportTarget(exportsField["."]) ?? workspacePackage.manifest.main;
  } else {
    target = workspacePackage.manifest.main;
  }
  return target ? resolveFile(path.resolve(workspacePackage.dir, target)) : undefined;
}

function resolveImport(packages, fromFile, specifier) {
  if (specifier.startsWith(".")) {
    return resolveFile(path.resolve(path.dirname(fromFile), specifier));
  }
  if (!specifier.startsWith("@task-handoff/")) return undefined;
  const segments = specifier.split("/");
  if (segments.length < 2) return undefined;
  return resolvePackageTarget(packages, segments.slice(0, 2).join("/"), segments.slice(2).join("/"));
}

const importPattern = /(?:import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?|export\s+(?:type\s+)?[^'";]+?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;

function collectImportClosure(workspaceRoot, entrypoints) {
  const packages = listWorkspacePackages(workspaceRoot);
  const files = new Set();
  const unresolved = [];
  const pending = entrypoints.map((entrypoint) => path.resolve(workspaceRoot, entrypoint));
  while (pending.length) {
    const filename = pending.pop();
    const relative = normalizeRelative(path.relative(workspaceRoot, filename));
    if (files.has(relative)) continue;
    files.add(relative);
    const source = fs.readFileSync(filename, "utf8");
    importPattern.lastIndex = 0;
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      const resolved = resolveImport(packages, filename, specifier);
      if (resolved) {
        pending.push(resolved);
        continue;
      }
      if (specifier.startsWith(".") || specifier.startsWith("@task-handoff/")) {
        unresolved.push({ from: relative, specifier });
      }
    }
  }
  return { files: [...files].sort(), packages, unresolved };
}

function globPattern(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function expandBraces(pattern) {
  const start = pattern.indexOf("{");
  if (start < 0) return [pattern];
  const end = pattern.indexOf("}", start + 1);
  if (end < 0) return [pattern];
  const prefix = pattern.slice(0, start);
  const suffix = pattern.slice(end + 1);
  return pattern.slice(start + 1, end).split(",").flatMap((alternative) => expandBraces(`${prefix}${alternative}${suffix}`));
}

function readInventory(workspaceRoot, inventoryPath) {
  return readJson(path.resolve(workspaceRoot, inventoryPath));
}

function assertFamiliesCoverClosure(closure, families) {
  const coverage = new Map();
  const compiled = families.map((family) => ({ family, matchers: expandBraces(family.source).map(globPattern) }));
  for (const filename of closure) {
    const matches = compiled.filter((entry) => entry.matchers.some((matcher) => matcher.test(filename))).map((entry) => entry.family);
    if (matches.length !== 1) {
      throw new Error(`Controlled-instance module ${filename} must match exactly one Rust ownership family; matched ${matches.length}.`);
    }
    coverage.set(filename, matches[0]);
  }
  return coverage;
}

function assertRustOwnership(workspaceRoot, inventory) {
  for (const family of inventory.families) {
    if (family.status !== "implemented") {
      throw new Error(`Controlled-instance ownership family ${family.source} is not marked implemented.`);
    }
    if (!Array.isArray(family.rust) || family.rust.length === 0) {
      throw new Error(`Controlled-instance ownership family ${family.source} has no Rust owner.`);
    }
    for (const owner of family.rust) {
      const ownerPath = path.resolve(workspaceRoot, owner);
      if (!owner.startsWith("controlled-instance-rs/crates/") || path.extname(owner) !== ".rs" || !fs.existsSync(ownerPath)) {
        throw new Error(`Controlled-instance ownership family ${family.source} names a missing Rust module: ${owner}.`);
      }
    }
    if (!Array.isArray(family.tests) || family.tests.length === 0) {
      throw new Error(`Controlled-instance ownership family ${family.source} has no contract test reference.`);
    }
    for (const test of family.tests) {
      if (!fs.existsSync(path.resolve(workspaceRoot, test))) {
        throw new Error(`Controlled-instance ownership family ${family.source} references a missing test: ${test}.`);
      }
    }
  }
}

function assertNoBusinessJavaScript(workspaceRoot, inventory) {
  const packageDir = path.resolve(workspaceRoot, "controlled-instance-rs/packaging");
  const scripts = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.[cm]?js$/.test(entry.name)) scripts.push(normalizeRelative(path.relative(workspaceRoot, absolute)));
    }
  };
  visit(packageDir);
  const unexpected = scripts.filter((script) => !approvedAdapterPaths.has(script));
  if (unexpected.length) {
    throw new Error(`Rust controlled-instance packaging contains unapproved JavaScript: ${unexpected.join(", ")}.`);
  }
  for (const adapter of inventory.adapters || []) {
    const filename = path.resolve(workspaceRoot, adapter.path);
    if (!fs.existsSync(filename)) throw new Error(`Controlled-instance adapter is missing: ${adapter.path}.`);
    const source = fs.readFileSync(filename, "utf8");
    for (const packageName of forbiddenAdapterPackages) {
      if (source.includes(packageName)) {
        throw new Error(`Controlled-instance adapter ${adapter.path} imports business package ${packageName}.`);
      }
    }
    if (/node-pty|packages\/controlled-instance\/src\/web|packages\/ai-session-runtime\/src|packages\/app-runtime\/src/.test(source)) {
      throw new Error(`Controlled-instance adapter ${adapter.path} contains a Node business fallback.`);
    }
  }
}

function assertFrozenUiBoundary(workspaceRoot) {
  const sourceRoot = path.resolve(workspaceRoot, uiRoot, "src");
  if (!fs.existsSync(sourceRoot)) return;
  const forbidden = /(?:from\s+|import\s*\(|require\s*\()["'](?:node-pty|@task-handoff\/(?:controlled-instance|ai-session-runtime|app-runtime)|(?:\.\.\/)+(?:packages|apps\/controlled-instance-image)\/)/;
  const pending = [sourceRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!/\.(?:[cm]?[jt]s|vue)$/.test(entry.name)) continue;
      const source = fs.readFileSync(absolute, "utf8");
      if (forbidden.test(source)) {
        throw new Error(`Frozen controlled-instance Web UI imports server business code: ${normalizeRelative(path.relative(workspaceRoot, absolute))}.`);
      }
    }
  }
}

function assertNoNodeFallback(workspaceRoot) {
  const sourceRoot = path.resolve(workspaceRoot, "controlled-instance-rs/crates");
  const patterns = [
    /packages\/controlled-instance\/src/,
    /controlled-instance-cli\.js/,
    /node-pty/,
  ];
  const pending = [sourceRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.name.endsWith(".rs")) {
        const source = fs.readFileSync(absolute, "utf8");
        if (patterns.some((pattern) => pattern.test(source))) {
          throw new Error(`Rust controlled-instance source contains a Node business fallback: ${normalizeRelative(path.relative(workspaceRoot, absolute))}.`);
        }
      }
    }
  }
}

export function checkControlledInstanceRustMigration(options = {}) {
  const workspaceRoot = path.resolve(options.root ?? root);
  const inventory = options.inventory ?? readInventory(workspaceRoot, inventoryRelativePath);
  const entrypoints = options.entrypoints ?? inventory.entrypoints;
  const closure = options.closure ?? collectImportClosure(workspaceRoot, entrypoints);
  if (closure.unresolved.length) {
    const details = closure.unresolved.map(({ from, specifier }) => `${from} -> ${specifier}`).join("\n");
    throw new Error(`Controlled-instance import closure has unresolved workspace modules:\n${details}`);
  }
  const excluded = new Set(inventory.exceptions?.map((exception) => exception.path) ?? []);
  const businessClosure = closure.files.filter((filename) => !excluded.has(filename));
  const coverage = assertFamiliesCoverClosure(businessClosure, inventory.families);
  assertRustOwnership(workspaceRoot, inventory);
  assertNoBusinessJavaScript(workspaceRoot, inventory);
  assertFrozenUiBoundary(workspaceRoot);
  assertNoNodeFallback(workspaceRoot);
  return {
    inventoryVersion: inventory.schemaVersion,
    entrypoints: entrypoints.length,
    discoveredModules: closure.files.length,
    businessModules: businessClosure.length,
    exceptions: [...excluded],
    families: inventory.families.length,
    coverage: Object.fromEntries([...coverage].map(([filename, family]) => [filename, family.source])),
  };
}

function main() {
  const report = checkControlledInstanceRustMigration();
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
