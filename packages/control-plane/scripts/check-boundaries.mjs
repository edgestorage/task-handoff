import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const defaultPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceRoot = path.resolve(option("--source-root") || path.join(defaultPackageRoot, "src"));
const packageRoot = path.resolve(option("--package-root") || path.dirname(sourceRoot));
const packageJsonPath = path.join(packageRoot, "package.json");
const packageJson = fs.existsSync(packageJsonPath)
  ? JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
  : {};
const packageName = option("--package-name") || packageJson.name || "@task-handoff/control-plane";
const controlPlaneRoot = path.join(sourceRoot, "control-plane");
const nodeAgentRoot = path.join(sourceRoot, "node-agent");
const sharedRoot = path.join(sourceRoot, "shared");
const compilerOptions = {
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  resolveJsonModule: true,
  target: ts.ScriptTarget.ESNext,
};

function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

function typescriptFiles(directory) {
  const canonicalDirectory = canonicalPath(directory);
  if (!canonicalDirectory) return [];
  const files = [];
  for (const entry of fs.readdirSync(canonicalDirectory, { withFileTypes: true })) {
    const entryPath = path.join(canonicalDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFiles(entryPath));
    } else if (entry.isFile() && /\.(?:cts|mts|tsx?|d\.ts)$/.test(entry.name)) {
      const canonicalFile = canonicalPath(entryPath);
      if (canonicalFile) files.push(canonicalFile);
    }
  }
  return files;
}

function moduleSpecifiers(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(filePath),
  );
  const specifiers = [];

  function addModuleSpecifier(moduleSpecifier) {
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addModuleSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addModuleSpecifier(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) addModuleSpecifier(argument.literal);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isDynamicImport && node.arguments.length >= 1) || (isRequire && node.arguments.length === 1)) {
        addModuleSpecifier(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function ownPackageExportTarget(specifier) {
  if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) return undefined;
  const exportKey = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  const configured = packageJson.exports?.[exportKey];
  const target = typeof configured === "string"
    ? configured
    : configured?.default || configured?.types;
  if (typeof target === "string") return canonicalPath(path.resolve(packageRoot, target));

  const subpath = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
  for (const candidate of [path.join(sourceRoot, `${subpath}.ts`), path.join(sourceRoot, subpath, "index.ts")]) {
    const canonicalCandidate = canonicalPath(candidate);
    if (canonicalCandidate) return canonicalCandidate;
  }
  return undefined;
}

function isLocalSpecifier(specifier) {
  return specifier.startsWith(".") || specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function resolveLocalImport(importer, specifier) {
  const ownPackageTarget = ownPackageExportTarget(specifier);
  if (ownPackageTarget) return ownPackageTarget;
  const result = ts.resolveModuleName(specifier, importer, compilerOptions, ts.sys);
  return result.resolvedModule?.resolvedFileName
    ? canonicalPath(result.resolvedModule.resolvedFileName)
    : undefined;
}

function isWithin(directory, candidate) {
  const canonicalDirectory = canonicalPath(directory);
  const canonicalCandidate = canonicalPath(candidate);
  if (!canonicalDirectory || !canonicalCandidate) return false;
  const relative = path.relative(canonicalDirectory, canonicalCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function checkGraph({ roots, isAllowedDependency, label }) {
  const pending = [...roots];
  const visited = new Set();
  const violations = [];

  while (pending.length > 0) {
    const importer = pending.pop();
    if (visited.has(importer)) continue;
    visited.add(importer);

    for (const specifier of moduleSpecifiers(importer)) {
      if (!isLocalSpecifier(specifier)) continue;
      const dependency = resolveLocalImport(importer, specifier);
      if (!dependency) {
        violations.push({ importer, specifier, reason: "unresolved local import" });
        continue;
      }
      if (!isAllowedDependency(dependency)) {
        violations.push({ importer, specifier, dependency, reason: "forbidden dependency" });
        continue;
      }
      if (/\.(?:cts|mts|tsx?|d\.ts)$/.test(dependency)) pending.push(dependency);
    }
  }

  if (violations.length === 0) return false;
  console.error(`${label}:`);
  for (const violation of violations) {
    const importer = path.relative(packageRoot, violation.importer);
    const dependency = violation.dependency ? ` (${path.relative(packageRoot, violation.dependency)})` : "";
    console.error(`- ${importer} imports ${violation.specifier}${dependency}: ${violation.reason}`);
  }
  return true;
}

const controlPlaneFailed = checkGraph({
  roots: typescriptFiles(controlPlaneRoot),
  isAllowedDependency: (filePath) => isWithin(controlPlaneRoot, filePath) || isWithin(sharedRoot, filePath),
  label: "control-plane modules must only import control-plane or shared modules",
});
const nodeAgentFailed = checkGraph({
  roots: typescriptFiles(nodeAgentRoot),
  isAllowedDependency: (filePath) => isWithin(nodeAgentRoot, filePath) || isWithin(sharedRoot, filePath),
  label: "node-agent modules must only import node-agent or shared modules",
});
const sharedFailed = checkGraph({
  roots: typescriptFiles(sharedRoot),
  isAllowedDependency: (filePath) => isWithin(sharedRoot, filePath),
  label: "shared modules must only import shared modules or external packages",
});

if (controlPlaneFailed || nodeAgentFailed || sharedFailed) process.exitCode = 1;
