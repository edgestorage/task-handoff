import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { appendRotatingLogSync, DEFAULT_OPEN_LOG_BACKUP_COUNT, DEFAULT_OPEN_LOG_MAX_BYTES } from "@task-handoff/core/storage/open-log-retention";

type LogLevel = "info" | "warn" | "error";
type LogSink = {
  info?: (data: unknown, message?: string) => void;
  warn?: (data: unknown, message?: string) => void;
  error?: (data: unknown, message?: string) => void;
};

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ARCHIVE_SOURCE_BYTES = 50 * 1024 * 1024;

function jsonLogValue(value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

export function createControlPlaneDiagnosticLogger(
  logsDir: string,
  enabled: () => boolean,
  sink: LogSink,
  options: { maxBytes?: number; backupCount?: number } = {},
): LogSink {
  const write = (level: LogLevel, data: unknown, message?: string) => {
    if (!enabled()) return;
    sink[level]?.(data, message);
    try {
      appendRotatingLogSync(path.join(logsDir, "control-plane.log"), `${JSON.stringify({
        time: new Date().toISOString(),
        level,
        message,
        data: jsonLogValue(data),
      }, (_key, value) => jsonLogValue(value))}\n`, options.maxBytes ?? DEFAULT_OPEN_LOG_MAX_BYTES, options.backupCount ?? DEFAULT_OPEN_LOG_BACKUP_COUNT);
    } catch {
      // Logging must never change request or runtime behavior.
    }
  };
  return {
    info: (data, message) => write("info", data, message),
    warn: (data, message) => write("warn", data, message),
    error: (data, message) => write("error", data, message),
  };
}

type ExportedLog = { source: string; archivePath: string; bytes: number; originalBytes: number };

function logFiles(root: string) {
  const files: string[] = [];
  const visit = (directory: string) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && (entry.name.endsWith(".log") || entry.name.endsWith(".jsonl"))) files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

function copyLogTail(source: string, destination: string, remainingBytes: number) {
  const stat = fs.statSync(source);
  const bytes = Math.min(stat.size, MAX_FILE_BYTES, remainingBytes);
  if (bytes <= 0) return 0;
  const buffer = Buffer.allocUnsafe(bytes);
  const descriptor = fs.openSync(source, "r");
  try {
    fs.readSync(descriptor, buffer, 0, bytes, Math.max(0, stat.size - bytes));
  } finally {
    fs.closeSync(descriptor);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, buffer, { mode: 0o600 });
  return bytes;
}

export async function createDiagnosticLogsArchive(options: {
  dataDir: string;
  nodeAgentDataDir?: string;
  diagnosticLogsEnabled: boolean;
}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-diagnostic-logs-"));
  const nodeAgentDataDir = path.resolve(options.nodeAgentDataDir || path.join(options.dataDir, "node-agent"));
  const localInstancesDir = path.join(nodeAgentDataDir, "local-instances");
  const localInstanceSources = fs.existsSync(localInstancesDir)
    ? fs.readdirSync(localInstancesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ label: path.join("local-instances", entry.name), root: path.join(localInstancesDir, entry.name, "logs") }))
    : [];
  const sources = [
    { label: "control-plane", root: path.join(options.dataDir, "logs") },
    { label: "desktop", root: path.join(options.dataDir, "log") },
    { label: "node-agent", root: path.join(nodeAgentDataDir, "logs") },
    ...localInstanceSources,
  ];
  const exported: ExportedLog[] = [];
  let totalBytes = 0;
  for (const source of sources) {
    for (const file of logFiles(source.root)) {
      if (totalBytes >= MAX_ARCHIVE_SOURCE_BYTES) break;
      const relative = path.relative(source.root, file);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const archivePath = path.join("logs", source.label, relative);
      const originalBytes = fs.statSync(file).size;
      const bytes = copyLogTail(file, path.join(stage, archivePath), MAX_ARCHIVE_SOURCE_BYTES - totalBytes);
      if (!bytes) continue;
      totalBytes += bytes;
      exported.push({ source: file, archivePath, bytes, originalBytes });
    }
  }
  fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    diagnosticLogsEnabled: options.diagnosticLogsEnabled,
    limits: { perFileBytes: MAX_FILE_BYTES, totalBytes: MAX_ARCHIVE_SOURCE_BYTES },
    files: exported.map(({ archivePath, bytes, originalBytes }) => ({ archivePath, bytes, originalBytes, truncated: bytes < originalBytes })),
  }, null, 2)}\n`, { mode: 0o600 });
  const entries = ["manifest.json", ...(fs.existsSync(path.join(stage, "logs")) ? ["logs"] : [])];
  const stream = tar.create({ cwd: stage, gzip: true, portable: true, noMtime: true }, entries);
  const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });
  stream.once("close", cleanup);
  stream.once("error", cleanup);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { filename: `task-handoff-diagnostic-logs-${timestamp}.tar.gz`, stream };
}
