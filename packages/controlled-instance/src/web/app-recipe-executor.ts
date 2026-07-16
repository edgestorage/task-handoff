import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AppManagementOperation, AppManagementProgress, FinalComputerCapabilities } from "@task-handoff/protocol/control-plane";
import type { ArchiveInstallRecipe, InstallRecipe, SystemPackageInstallRecipe } from "@task-handoff/app-runtime/types";

const MAX_LOG_CHARS = 8_192;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const PACKAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9+._:@/-]{0,199}$/;

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
  commandRunner?: (command: AppRecipeCommand, hooks?: AppRecipeCommandHooks) => Promise<AppRecipeCommandResult>;
  fetcher?: typeof fetch;
};

function bounded(value: string) {
  return value.length <= MAX_LOG_CHARS ? value : value.slice(value.length - MAX_LOG_CHARS);
}

export function runAppRecipeCommand(command: AppRecipeCommand, hooks: AppRecipeCommandHooks = {}): Promise<AppRecipeCommandResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command.executable, command.args, { shell: false, detached, stdio: ["ignore", "pipe", "pipe"] });
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

function packageCommand(recipe: SystemPackageInstallRecipe, operation: AppManagementOperation, capabilities: FinalComputerCapabilities): AppRecipeCommand {
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
    return { executable: selected.executable, args, timeoutMs: 15 * 60_000 };
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

function safeRelativeArchivePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return undefined;
  const segments = normalized.split("/").filter(Boolean);
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

function parseTarListing(output: string) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const type = line[0] === "d" ? "directory" : line[0] === "l" ? "symlink" : line[0] === "h" ? "hardlink" : "file";
    const columns = line.trim().split(/\s+/);
    const marker = columns.findIndex((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
    const pathStart = marker >= 0 ? marker + 2 : Math.max(0, columns.length - 1);
    return { path: columns.slice(pathStart).join(" ").split(" -> ")[0], type } as const;
  });
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

function atomicJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
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

async function installArchive(recipe: ArchiveInstallRecipe, context: AppRecipeExecutionContext, options: Required<Pick<AppRecipeExecutorOptions, "commandRunner" | "fetcher">> & AppRecipeExecutorOptions) {
  const runCommand = (command: AppRecipeCommand) => {
    context.onCommand?.({ executable: command.executable, args: [...command.args] });
    return options.commandRunner(command, { onOutput: context.onOutput });
  };
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
    if (recipe.format === "zip") throw new AppRecipeExecutionError("unsupported_archive_format", "ZIP managed artifacts are not enabled by this controlled instance.");
    const compression = recipe.format === "tar.gz" ? "-tzvf" : "-tJvf";
    const listing = await runCommand({ executable: "tar", args: [compression, artifact], timeoutMs: 60_000 });
    if (listing.exitCode !== 0) throw new AppRecipeExecutionError("archive_inspection_failed", bounded(listing.stderr) || "Artifact could not be inspected.");
    validateArchiveEntries(parseTarListing(listing.stdout));
    fs.mkdirSync(extracted, { recursive: true });
    context.onPhase?.("extract");
    const extractCompression = recipe.format === "tar.gz" ? "-xzvf" : "-xJvf";
    const extraction = await runCommand({
      executable: "tar",
      args: [extractCompression, artifact, "--no-same-owner", "--no-same-permissions", "-C", extracted],
      timeoutMs: 5 * 60_000,
    });
    if (extraction.exitCode !== 0) throw new AppRecipeExecutionError("archive_extraction_failed", bounded(extraction.stderr) || "Artifact could not be extracted.");
    const files = walkOwnedFiles(extracted);
    fs.renameSync(extracted, installRoot);
    atomicJson(manifestPath(options.stateDir, context.appId), { schemaVersion: 1, appId: context.appId, installRoot, files });
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
      const command = packageCommand(recipe, operation, context.capabilities);
      if (operation === "install" && recipe.installer === "apt") {
        const refresh = await runCommand(aptRefreshCommand(context.capabilities, recipe));
        if (refresh.exitCode !== 0) throw new AppRecipeExecutionError("package_manager_failed", bounded(refresh.stderr) || "The apt package index could not be refreshed.", true);
      }
      const result = await runCommand(command);
      if (result.exitCode !== 0) throw new AppRecipeExecutionError("package_manager_failed", bounded(result.stderr) || "The system package manager failed.", true);
      return { log: bounded(result.stdout || result.stderr) };
    }
    if (operation === "install") await installArchive(recipe, context, resolved);
    else uninstallArchive(recipe, context, resolved);
    return { log: "" };
  };
}
