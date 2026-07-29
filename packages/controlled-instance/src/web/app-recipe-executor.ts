import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import type { AppManagementOperation, AppManagementProgress, FinalComputerCapabilities } from "@task-handoff/protocol/control-plane";
import { resolveExecutable } from "@task-handoff/app-runtime";
import type { ArchiveInstallRecipe, InstallRecipe, NodePackageInstallRecipe, SystemPackageInstallRecipe } from "@task-handoff/app-runtime/types";
import { atomicWriteJsonSync } from "@task-handoff/core/storage/atomic-write";
import { extract as extractTar, list as listTar, type ReadEntry } from "tar";

const MAX_LOG_CHARS = 8_192;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9+._:@/-]{0,199}$/;
const NODE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/i;

export class AppRecipeExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "AppRecipeExecutionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type AppRecipeCommand = {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  terminationGraceMs?: number;
};

export type AppRecipeCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type AppRecipeCommandHooks = {
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
};

export type AppRecipeExecutionContext = {
  appId: string;
  capabilities: FinalComputerCapabilities;
  onPhase?: (phase: string, progress?: AppManagementProgress) => void;
  onCommand?: (command: Pick<AppRecipeCommand, "executable" | "args">) => void;
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
};

export type AppRecipeExecutorOptions = {
  installBaseDir: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: (command: AppRecipeCommand, hooks?: AppRecipeCommandHooks) => Promise<AppRecipeCommandResult>;
  fetcher?: typeof fetch;
};

function bounded(value: string) {
  return value.length <= MAX_LOG_CHARS ? value : value.slice(value.length - MAX_LOG_CHARS);
}

export function runAppRecipeCommand(command: AppRecipeCommand, hooks: AppRecipeCommandHooks = {}): Promise<AppRecipeCommandResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command.executable, command.args, {
      shell: false,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
      ...(command.env ? { env: command.env } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.on("data", (chunk) => {
      const value = String(chunk);
      stdout = bounded(stdout + value);
      hooks.onOutput?.("stdout", value);
    });
    child.stderr.on("data", (chunk) => {
      const value = String(chunk);
      stderr = bounded(stderr + value);
      hooks.onOutput?.("stderr", value);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      signalChildProcess(child, detached, "SIGTERM");
      forceKillTimer = setTimeout(() => signalChildProcess(child, detached, "SIGKILL"), command.terminationGraceMs ?? 5_000);
      forceKillTimer.unref?.();
    }, command.timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(new AppRecipeExecutionError("command_start_failed", error.message, true));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (timedOut) reject(new AppRecipeExecutionError("command_timeout", `App installer command timed out after ${command.timeoutMs}ms.`, true));
      else resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
  });
}

function signalChildProcess(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, detached: boolean, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(detached ? -child.pid : child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited between the timeout and signal delivery.
    }
  }
}

function resolvedCommand(executable: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): AppRecipeCommand {
  const resolution = resolveExecutable(executable, { env, platform });
  return resolution?.env
    ? { executable: resolution.executable, args, timeoutMs, env: { ...env, ...resolution.env } }
    : { executable, args, timeoutMs };
}

function packageCommand(recipe: SystemPackageInstallRecipe, operation: AppManagementOperation, capabilities: FinalComputerCapabilities, env: NodeJS.ProcessEnv): AppRecipeCommand {
  if (!recipe.packages.length || recipe.packages.some((item) => !PACKAGE_NAME.test(item))) {
    throw new AppRecipeExecutionError("invalid_builtin_recipe", "The built-in system package recipe contains an invalid package name.");
  }
  if (!capabilities.installers.includes(recipe.installer)) {
    throw new AppRecipeExecutionError("installer_unavailable", `The ${recipe.installer} installer is unavailable.`);
  }
  const definitions = {
    apt: { executable: "apt-get", install: ["install", "-y", "--no-install-recommends"], uninstall: ["remove", "-y"] },
    dnf: { executable: "dnf", install: ["install", "-y"], uninstall: ["remove", "-y"] },
    brew: { executable: "brew", install: ["install"], uninstall: ["uninstall"] },
  } as const;
  const selected = definitions[recipe.installer];
  const args = [...selected[operation], ...recipe.packages];
  if (capabilities.privilege === "root" || recipe.privilege === "user") {
    return resolvedCommand(selected.executable, args, 15 * 60_000, env, capabilities.platform as NodeJS.Platform);
  }
  if (capabilities.privilege === "passwordless-sudo") {
    return { executable: "sudo", args: ["-n", selected.executable, ...args], timeoutMs: 15 * 60_000 };
  }
  throw new AppRecipeExecutionError("insufficient_privilege", "The controlled instance cannot run this system package recipe.");
}

function aptRefreshCommand(capabilities: FinalComputerCapabilities, recipe: SystemPackageInstallRecipe): AppRecipeCommand {
  if (capabilities.privilege === "root" || recipe.privilege === "user") {
    return { executable: "apt-get", args: ["update"], timeoutMs: 15 * 60_000 };
  }
  if (capabilities.privilege === "passwordless-sudo") {
    return { executable: "sudo", args: ["-n", "apt-get", "update"], timeoutMs: 15 * 60_000 };
  }
  throw new AppRecipeExecutionError("insufficient_privilege", "The controlled instance cannot refresh the apt package index.");
}

function nodePackageCommand(recipe: NodePackageInstallRecipe, operation: AppManagementOperation, capabilities: FinalComputerCapabilities, env: NodeJS.ProcessEnv): AppRecipeCommand {
  if (!recipe.packages.length || recipe.packages.some((item) => !NODE_PACKAGE_NAME.test(item))) {
    throw new AppRecipeExecutionError("invalid_builtin_recipe", "The built-in Node package recipe contains an invalid package name.");
  }
  if (!capabilities.installers.includes(recipe.installer)) {
    throw new AppRecipeExecutionError("installer_unavailable", `The ${recipe.installer} installer is unavailable.`);
  }
  const args = operation === "install"
    ? ["install", "--global", "--include=optional", "--no-audit", "--no-fund", ...recipe.packages]
    : ["uninstall", "--global", ...recipe.packages];
  const resolution = resolveExecutable(recipe.installer, { env, platform: capabilities.platform as NodeJS.Platform });
  const installerExecutable = capabilities.platform === "win32"
    ? resolution?.executable || `${recipe.installer}.cmd`
    : resolution?.env ? resolution.executable : recipe.installer;
  const command = capabilities.platform === "win32"
    ? { executable: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "call", installerExecutable, ...args], timeoutMs: 15 * 60_000, ...(resolution?.env ? { env: { ...env, ...resolution.env } } : {}) }
    : { executable: installerExecutable, args, timeoutMs: 15 * 60_000, ...(resolution?.env ? { env: { ...env, ...resolution.env } } : {}) };
  if (capabilities.privilege === "root" || recipe.privilege === "user") {
    return command;
  }
  if (capabilities.privilege === "passwordless-sudo") {
    return { executable: "sudo", args: ["-n", recipe.installer, ...args], timeoutMs: 15 * 60_000 };
  }
  throw new AppRecipeExecutionError("insufficient_privilege", "The controlled instance cannot run this Node package recipe.");
}

function npmRetirementDirectory(stderr: string, recipe: NodePackageInstallRecipe) {
  if (!/(?:^|\n)npm ERR! code ENOTEMPTY\r?$/m.test(stderr)) return undefined;
  const source = stderr.match(/(?:^|\n)npm ERR! path (.+)\r?$/m)?.[1]?.trim();
  const destination = stderr.match(/(?:^|\n)npm ERR! dest (.+)\r?$/m)?.[1]?.trim();
  if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) return undefined;
  const packageName = recipe.packages.length === 1 ? recipe.packages[0] : undefined;
  const segments = packageName?.split("/").filter(Boolean);
  const leaf = segments?.at(-1);
  if (!segments?.length || !leaf || !source.endsWith(path.join("node_modules", ...segments))) return undefined;
  if (path.dirname(source) !== path.dirname(destination)) return undefined;
  const escapedLeaf = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\.${escapedLeaf}-[A-Za-z0-9_-]+$`).test(path.basename(destination))) return undefined;
  return destination;
}

function npmRetirementCleanupCommand(command: AppRecipeCommand, destination: string, capabilities: FinalComputerCapabilities): AppRecipeCommand {
  if (capabilities.platform === "win32") {
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "rmdir", "/s", "/q", destination], timeoutMs: 60_000 };
  }
  const prefix = command.executable === "sudo" ? ["-n"] : [];
  return command.executable === "sudo"
    ? { executable: "sudo", args: [...prefix, "rm", "-rf", "--", destination], timeoutMs: 60_000 }
    : { executable: "rm", args: ["-rf", "--", destination], timeoutMs: 60_000 };
}

function safeRelativeArchivePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return undefined;
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment === "..")) return undefined;
  return segments.join("/");
}

export function validateArchiveEntries(entries: Array<{ path: string; type?: "file" | "directory" | "symlink" | "hardlink" }>) {
  const normalized: string[] = [];
  for (const entry of entries) {
    const safePath = safeRelativeArchivePath(entry.path);
    if (!safePath || entry.type === "symlink" || entry.type === "hardlink") {
      throw new AppRecipeExecutionError("unsafe_archive", "The built-in artifact contains an unsafe path or link.");
    }
    normalized.push(safePath);
  }
  return normalized;
}

function controlledPath(baseDir: string, relativePath: string) {
  if (path.isAbsolute(relativePath)) throw new AppRecipeExecutionError("invalid_builtin_recipe", "Archive installRoot must be relative to the managed app root.");
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, relativePath);
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) {
    throw new AppRecipeExecutionError("invalid_builtin_recipe", "Archive installRoot escapes the managed app root.");
  }
  return resolved;
}

async function downloadArtifact(url: string, destination: string, expectedSha256: string, fetcher: typeof fetch, onProgress?: AppRecipeExecutionContext["onPhase"]) {
  if (!url.startsWith("https://") || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new AppRecipeExecutionError("invalid_builtin_recipe", "Archive recipes require HTTPS and a SHA-256 checksum.");
  }
  const response = await fetcher(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new AppRecipeExecutionError("download_failed", `Artifact download failed with HTTP ${response.status}.`, true);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) throw new AppRecipeExecutionError("artifact_too_large", "Artifact exceeds the managed download limit.");
  const fd = fs.openSync(destination, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength;
      if (received > MAX_ARCHIVE_BYTES) throw new AppRecipeExecutionError("artifact_too_large", "Artifact exceeds the managed download limit.");
      fs.writeSync(fd, chunk);
      hash.update(chunk);
      onProgress?.("download", { current: received, ...(Number.isFinite(declaredLength) && declaredLength > 0 ? { total: declaredLength } : {}), unit: "bytes" });
    }
  } finally {
    fs.closeSync(fd);
  }
  if (hash.digest("hex") !== expectedSha256.toLowerCase()) {
    throw new AppRecipeExecutionError("checksum_mismatch", "Artifact checksum does not match the built-in recipe.");
  }
}

function manifestPath(stateDir: string, appId: string) {
  return path.join(stateDir, "manifests", `${appId}.json`);
}

function walkOwnedFiles(root: string, current = root): string[] {
  const values: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new AppRecipeExecutionError("unsafe_archive", "Extracted archive contains a symbolic link.");
    if (stat.isDirectory()) values.push(...walkOwnedFiles(root, absolute));
    else if (stat.isFile()) values.push(relative);
    else throw new AppRecipeExecutionError("unsafe_archive", "Extracted archive contains an unsupported file type.");
  }
  return values;
}

function archiveEntryKind(entry: ReadEntry) {
  if (["File", "OldFile", "ContiguousFile"].includes(entry.type)) return "file" as const;
  if (["Directory", "GNUDumpDir"].includes(entry.type)) return "directory" as const;
  if (entry.type === "SymbolicLink") return "symlink" as const;
  if (entry.type === "Link") return "hardlink" as const;
  return undefined;
}

function createArchiveValidator() {
  const paths = new Set<string>();
  let entries = 0;
  let extractedBytes = 0;
  return (entry: ReadEntry) => {
    if (entry.meta) return true;
    const kind = archiveEntryKind(entry);
    if (!kind) throw new AppRecipeExecutionError("unsafe_archive", `Archive contains unsupported entry type ${entry.type}.`);
    if (entry.path.includes("\\") || entry.path.includes("\0")) {
      throw new AppRecipeExecutionError("unsafe_archive", "The built-in artifact contains an unsafe path.");
    }
    const [safePath] = validateArchiveEntries([{ path: entry.path, type: kind }]);
    if (paths.has(safePath)) throw new AppRecipeExecutionError("unsafe_archive", `Archive contains duplicate path: ${safePath}`);
    paths.add(safePath);
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) throw new AppRecipeExecutionError("archive_too_large", "Artifact contains too many entries.");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new AppRecipeExecutionError("unsafe_archive", "Artifact contains an invalid entry size.");
    extractedBytes += entry.size;
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new AppRecipeExecutionError("archive_too_large", "Extracted artifact exceeds the managed size limit.");
    return true;
  };
}

async function pipeArchive(recipe: ArchiveInstallRecipe, artifact: string, target: NodeJS.WritableStream, timeoutMs: number) {
  if (recipe.format === "zip") throw new AppRecipeExecutionError("unsupported_archive_format", "ZIP managed artifacts are not enabled by this controlled instance.");
  if (recipe.format === "tar.gz") {
    const source = fs.createReadStream(artifact).pipe(createGunzip());
    const timer = setTimeout(() => source.destroy(new Error(`Archive decompression timed out after ${timeoutMs}ms.`)), timeoutMs);
    timer.unref?.();
    try {
      await consumeArchiveStream(source, target);
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  const child = spawn("xz", ["-dc", "--", artifact], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let timedOut = false;
  child.stderr.on("data", (chunk) => { stderr = bounded(stderr + String(chunk)); });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(timedOut ? `Archive decompression timed out after ${timeoutMs}ms.` : stderr || `xz exited with code ${code}`)));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref?.();
  try {
    await Promise.all([consumeArchiveStream(child.stdout, target), completed]);
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function consumeArchiveStream(source: NodeJS.ReadableStream & AsyncIterable<Buffer>, target: NodeJS.WritableStream) {
  let targetError: unknown;
  let cleanupCompletionListeners = () => {};
  const completed = new Promise<void>((resolve) => {
    const complete = () => {
      cleanupCompletionListeners();
      resolve();
    };
    const fail = (error: unknown) => {
      targetError = error;
      destroyReadable(source, error);
      complete();
    };
    cleanupCompletionListeners = () => {
      target.off("error", fail);
      target.off("close", complete);
      target.off("finish", complete);
      target.off("end", complete);
    };
    target.once("error", fail);
    target.once("close", complete);
    target.once("finish", complete);
    target.once("end", complete);
  });
  try {
    for await (const chunk of source) {
      if (targetError) throw targetError;
      if (!target.write(chunk)) await waitForDrain(target);
    }
    if (targetError) throw targetError;
    target.end();
    await completed;
    if (targetError) throw targetError;
  } catch (error) {
    abortWritable(target, error);
    throw error;
  } finally {
    cleanupCompletionListeners();
  }
}

function waitForDrain(target: NodeJS.WritableStream) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.off("drain", drained);
      target.off("error", failed);
      target.off("close", closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const closed = () => {
      cleanup();
      reject(new Error("Archive parser closed before accepting the complete stream."));
    };
    target.once("drain", drained);
    target.once("error", failed);
    target.once("close", closed);
  });
}

function destroyReadable(source: NodeJS.ReadableStream, error: unknown) {
  const destroy = (source as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy;
  if (typeof destroy === "function") destroy.call(source, error instanceof Error ? error : new Error(String(error)));
}

function abortWritable(target: NodeJS.WritableStream, error: unknown) {
  const abort = (target as NodeJS.WritableStream & { abort?: (error?: Error) => void }).abort;
  if (typeof abort === "function") abort.call(target, error instanceof Error ? error : new Error(String(error)));
}

async function inspectArchive(recipe: ArchiveInstallRecipe, artifact: string) {
  const validate = createArchiveValidator();
  const parser = listTar({ strict: true, maxMetaEntrySize: 1024 * 1024, filter: (_entryPath, entry) => validate(entry as ReadEntry) });
  await pipeArchive(recipe, artifact, parser, 60_000);
}

async function extractArchive(recipe: ArchiveInstallRecipe, artifact: string, destination: string) {
  const validate = createArchiveValidator();
  const unpack = extractTar({
    cwd: destination,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    chmod: false,
    maxDepth: 100,
    unlink: true,
    maxMetaEntrySize: 1024 * 1024,
    filter: (_entryPath, entry) => validate(entry as ReadEntry),
  });
  await pipeArchive(recipe, artifact, unpack, 5 * 60_000);
}

async function installArchive(recipe: ArchiveInstallRecipe, context: AppRecipeExecutionContext, options: Required<Pick<AppRecipeExecutorOptions, "commandRunner" | "fetcher">> & AppRecipeExecutorOptions) {
  const installRoot = controlledPath(options.installBaseDir, recipe.installRoot);
  if (fs.existsSync(installRoot)) throw new AppRecipeExecutionError("install_target_exists", "The managed install target already exists.");
  fs.mkdirSync(path.dirname(installRoot), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(installRoot), `.install-${context.appId}-`));
  const artifact = path.join(staging, `artifact.${recipe.format.replace(".", "-")}`);
  const extracted = path.join(staging, "root");
  try {
    context.onPhase?.("download");
    await downloadArtifact(recipe.url, artifact, recipe.sha256, options.fetcher, context.onPhase);
    context.onPhase?.("inspect");
    try {
      await inspectArchive(recipe, artifact);
    } catch (error) {
      if (error instanceof AppRecipeExecutionError) throw error;
      throw new AppRecipeExecutionError("archive_inspection_failed", error instanceof Error ? error.message : "Artifact could not be inspected.");
    }
    fs.mkdirSync(extracted, { recursive: true });
    context.onPhase?.("extract");
    try {
      await extractArchive(recipe, artifact, extracted);
    } catch (error) {
      if (error instanceof AppRecipeExecutionError) throw error;
      throw new AppRecipeExecutionError("archive_extraction_failed", error instanceof Error ? error.message : "Artifact could not be extracted.");
    }
    const files = walkOwnedFiles(extracted);
    const ownershipManifest = manifestPath(options.stateDir, context.appId);
    atomicWriteJsonSync(ownershipManifest, { schemaVersion: 1, appId: context.appId, installRoot, files });
    try {
      fs.renameSync(extracted, installRoot);
    } catch (error) {
      fs.rmSync(ownershipManifest, { force: true });
      throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function uninstallArchive(recipe: ArchiveInstallRecipe, context: AppRecipeExecutionContext, options: AppRecipeExecutorOptions) {
  const expectedRoot = controlledPath(options.installBaseDir, recipe.installRoot);
  const filePath = manifestPath(options.stateDir, context.appId);
  if (!fs.existsSync(filePath)) throw new AppRecipeExecutionError("ownership_manifest_missing", "The archive ownership manifest is missing.");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { installRoot?: unknown; files?: unknown };
  if (raw.installRoot !== expectedRoot || !Array.isArray(raw.files)) throw new AppRecipeExecutionError("ownership_manifest_invalid", "The archive ownership manifest is invalid.");
  const files = validateArchiveEntries(raw.files.map((item) => ({ path: String(item), type: "file" as const })));
  for (const relative of files) {
    const owned = path.resolve(expectedRoot, relative);
    if (!owned.startsWith(`${expectedRoot}${path.sep}`)) throw new AppRecipeExecutionError("ownership_manifest_invalid", "An owned path escapes the managed install root.");
    try { fs.unlinkSync(owned); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const directories = new Set(files.map((item) => path.dirname(path.join(expectedRoot, item))));
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(directory); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
  }
  try { fs.rmdirSync(expectedRoot); } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error; }
  fs.unlinkSync(filePath);
}

export function createAppRecipeExecutor(options: AppRecipeExecutorOptions) {
  const resolved = {
    ...options,
    env: options.env || process.env,
    commandRunner: options.commandRunner || runAppRecipeCommand,
    fetcher: options.fetcher || fetch,
  };
  return async (operation: AppManagementOperation, recipe: InstallRecipe, context: AppRecipeExecutionContext) => {
    const runCommand = (command: AppRecipeCommand) => {
      context.onCommand?.({ executable: command.executable, args: [...command.args] });
      return resolved.commandRunner(command, { onOutput: context.onOutput });
    };
    if (recipe.type === "bundled") throw new AppRecipeExecutionError("bundled_app", "Bundled apps do not support managed installation or removal.");
    if (recipe.type === "system-package") {
      context.onPhase?.(operation === "install" ? "install-package" : "uninstall-package");
      const command = packageCommand(recipe, operation, context.capabilities, resolved.env);
      if (operation === "install" && recipe.installer === "apt") {
        const refresh = await runCommand(aptRefreshCommand(context.capabilities, recipe));
        if (refresh.exitCode !== 0) throw new AppRecipeExecutionError("package_manager_failed", bounded(refresh.stderr) || "The apt package index could not be refreshed.", true);
      }
      const result = await runCommand(command);
      if (result.exitCode !== 0) throw new AppRecipeExecutionError("package_manager_failed", bounded(result.stderr) || "The system package manager failed.", true);
      return { log: bounded(result.stdout || result.stderr) };
    }
    if (recipe.type === "node-package") {
      context.onPhase?.(operation === "install" ? "install-node-package" : "uninstall-node-package");
      const command = nodePackageCommand(recipe, operation, context.capabilities, resolved.env);
      let result = await runCommand(command);
      const retirementDirectory = result.exitCode === 0 ? undefined : npmRetirementDirectory(result.stderr, recipe);
      if (retirementDirectory) {
        context.onPhase?.("cleanup-node-package");
        const cleanup = await runCommand(npmRetirementCleanupCommand(command, retirementDirectory, context.capabilities));
        if (cleanup.exitCode !== 0) throw new AppRecipeExecutionError("package_cleanup_failed", bounded(cleanup.stderr) || "The stale Node package directory could not be removed.", true);
        result = await runCommand(command);
      }
      if (result.exitCode !== 0) throw new AppRecipeExecutionError("package_manager_failed", bounded(result.stderr) || "The Node package manager failed.", true);
      return { log: bounded(result.stdout || result.stderr) };
    }
    if (operation === "install") await installArchive(recipe, context, resolved);
    else uninstallArchive(recipe, context, resolved);
    return { log: "" };
  };
}
