#!/usr/bin/env node

const fs = require("node:fs");
const { builtinModules } = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_DIRS = ["apps", "packages"];
const CHECK_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs", ".vue", ".css"]);
const IGNORED_DIRS = new Set(["dist", "build", "node_modules", ".turbo", ".vite"]);
const CSS_IMPORT_SPECIFIER = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;
const CSS_URL_SPECIFIER = /\burl\(\s*["']?([^"')]+)["']?\s*\)/g;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED_DIRS.has(entry.name)) return [];
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (!entry.isFile() || !CHECK_EXTENSIONS.has(path.extname(entry.name))) return [];
    return [fullPath];
  });
}

function readManifest(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function workspacePackages(root) {
  const packages = [];
  for (const workspaceDir of WORKSPACE_DIRS) {
    const absoluteDir = path.join(root, workspaceDir);
    if (!fs.existsSync(absoluteDir)) continue;
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageDir = path.join(absoluteDir, entry.name);
      const manifest = readManifest(packageDir);
      if (!manifest?.name) continue;
      packages.push({ kind: workspaceDir === "apps" ? "app" : "package", packageDir, manifest });
    }
  }
  return packages;
}

function ownerForPath(file, packages) {
  const absoluteFile = path.resolve(file);
  return packages.find(({ packageDir }) => absoluteFile === packageDir || absoluteFile.startsWith(`${packageDir}${path.sep}`));
}

function dependencyName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function importSubpath(specifier, packageName) {
  if (specifier === packageName) return ".";
  return `.${specifier.slice(packageName.length)}`;
}

function matchesExport(exportKey, subpath) {
  if (!exportKey.includes("*")) return exportKey === subpath;
  const [prefix, suffix] = exportKey.split("*");
  return subpath.startsWith(prefix) && subpath.endsWith(suffix);
}

function isExported(manifest, subpath) {
  if (subpath === "." && manifest.exports === undefined) return true;
  if (typeof manifest.exports === "string" || Array.isArray(manifest.exports)) return subpath === ".";
  if (!manifest.exports || typeof manifest.exports !== "object") return false;
  const keys = Object.keys(manifest.exports);
  if (!keys.some((key) => key.startsWith("."))) return subpath === ".";
  return keys.some((key) => matchesExport(key, subpath));
}

function sourceSpecifiers(file, source) {
  const specifiers = [];
  const extension = path.extname(file);
  const scripts = extension === ".vue" ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]) : [source];
  if (extension !== ".css") {
    for (const script of scripts) {
      const sourceFile = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
      const visit = (node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          specifiers.push(node.moduleSpecifier.text);
        } else if (
          ts.isCallExpression(node) &&
          node.arguments.length > 0 &&
          ts.isStringLiteral(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
          specifiers.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  if (path.extname(file) === ".css" || path.extname(file) === ".vue") {
    for (const match of source.matchAll(CSS_IMPORT_SPECIFIER)) specifiers.push(match[1]);
    for (const match of source.matchAll(CSS_URL_SPECIFIER)) specifiers.push(match[1]);
  }
  return [...new Set(specifiers)];
}

function isIgnoredSpecifier(specifier) {
  return (
    !specifier ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("data:") ||
    specifier.startsWith("http://") ||
    specifier.startsWith("https://") ||
    specifier.startsWith("//")
  );
}

function declaredDependencies(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
    ...Object.keys(manifest.peerDependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ]);
}

function checkWorkspace(root = DEFAULT_ROOT) {
  const packages = workspacePackages(root);
  const packagesByName = new Map(packages.map((owner) => [owner.manifest.name, owner]));
  const violations = [];
  const enterpriseRoot = path.resolve(root, "ee");

  for (const owner of packages) {
    const declared = declaredDependencies(owner.manifest);
    for (const dependency of declared) {
      const target = packagesByName.get(dependency);
      if (owner.kind === "package" && target?.kind === "app") {
        violations.push(`${path.relative(root, owner.packageDir)}/package.json: reusable packages must not depend on app ${dependency}`);
      }
    }

    for (const file of walk(owner.packageDir)) {
      const relativeFile = path.relative(root, file);
      const source = fs.readFileSync(file, "utf8");
      for (const rawSpecifier of sourceSpecifiers(file, source)) {
        if (isIgnoredSpecifier(rawSpecifier)) continue;
        const specifier = rawSpecifier.split(/[?#]/, 1)[0];

        if (specifier.startsWith(".")) {
          const targetPath = path.resolve(path.dirname(file), specifier);
          if (targetPath === enterpriseRoot || targetPath.startsWith(`${enterpriseRoot}${path.sep}`)) {
            violations.push(`${relativeFile}: open-source workspace must not import ignored EE source: ${rawSpecifier}`);
            continue;
          }
          const targetOwner = ownerForPath(targetPath, packages);
          if (targetOwner && targetOwner !== owner) {
            violations.push(`${relativeFile}: relative import crosses into ${targetOwner.manifest.name}: ${rawSpecifier}`);
          }
          continue;
        }

        if (specifier.startsWith("node:") || BUILTINS.has(specifier)) continue;
        const dependency = dependencyName(specifier);
        const target = packagesByName.get(dependency);

        if (dependency === owner.manifest.name) {
          violations.push(`${relativeFile}: package-internal imports must be relative: ${rawSpecifier}`);
          continue;
        }
        if (!declared.has(dependency)) {
          violations.push(`${relativeFile}: imports undeclared dependency ${dependency}`);
          continue;
        }
        if (owner.kind === "package" && target?.kind === "app") {
          violations.push(`${relativeFile}: reusable packages must not import app ${dependency}`);
          continue;
        }
        if (target) {
          const subpath = importSubpath(specifier, dependency);
          if (!isExported(target.manifest, subpath)) {
            violations.push(`${relativeFile}: ${rawSpecifier} is not exported by ${dependency}`);
          }
        }
      }
    }
  }

  return [...new Set(violations)].sort();
}

function main() {
  const violations = checkWorkspace();
  if (violations.length) {
    console.error("Package boundary violations:");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log("Package boundary check passed.");
}

if (require.main === module) main();

module.exports = { checkWorkspace, isExported, sourceSpecifiers };
