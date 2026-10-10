import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Host-side local IPC endpoints.
 *
 * Node binds and connects unix domain sockets on POSIX and named pipes on
 * Windows. The Codex CLI additionally speaks AF_UNIX on Windows (through
 * `uds_windows`), but Node cannot connect to an AF_UNIX endpoint on Windows;
 * those endpoints keep an AF_UNIX path on every platform and are reached
 * through the CLI stdio proxy (`codex app-server proxy --sock <path>`). The
 * `kind` field selects that behaviour so callers never branch on
 * `process.platform` or assemble `.sock` paths themselves.
 */
export type LocalIpcEndpointKind = "host-ipc" | "codex-af-unix";

export type LocalIpcTransport = "unix-socket" | "named-pipe";

export type LocalIpcEndpoint = {
  /** Socket path (POSIX / Codex AF_UNIX) or `\\.\pipe\<name>` (Windows host IPC). */
  readonly path: string;
  readonly transport: LocalIpcTransport;
  readonly kind: LocalIpcEndpointKind;
  readonly platform: NodeJS.Platform;
  /**
   * Named pipes have no filesystem entity, so prepare/cleanup are no-ops and
   * stale-entity handling does not apply.
   */
  readonly filesystemBacked: boolean;
};

export type LocalIpcEndpointOptions = {
  /** Endpoint family; decides the Windows transport. Defaults to `host-ipc`. */
  kind?: LocalIpcEndpointKind;
  /** Endpoint name prefix, e.g. `task-handoff-codex`. */
  scope: string;
  /**
   * Explicit scope name override. Legacy endpoints keep their published
   * directory/pipe name instead of the derived `<scope>-<hash>`.
   */
  directoryName?: string;
  /** Stable uniqueness input; hashed (never escaped) into the endpoint name. */
  key: string;
  /** POSIX socket file name inside the scope directory. Defaults to `ipc.sock`. */
  fileName?: string;
  /** Explicit path override (for example an env-provided socket). Wins over the generated layout. */
  explicitPath?: string;
  /** Root directory override; defaults to `/private/tmp` on darwin and `os.tmpdir()` elsewhere. */
  rootDir?: string;
  /** Injectable temporary directory for tests; used instead of `os.tmpdir()`. */
  temporaryDirectory?: string;
  platform?: NodeJS.Platform;
  /** Hash length used in the endpoint name. Defaults to 16. */
  hashLength?: number;
};

export type LocalIpcTempEndpoint = {
  endpoint: LocalIpcEndpoint;
  /** Scope directory created for this endpoint; absent for named pipes. */
  directory?: string;
};

function endpointError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function localIpcTransportFor(
  kind: LocalIpcEndpointKind,
  platform: NodeJS.Platform = process.platform,
): LocalIpcTransport {
  return platform === "win32" && kind === "host-ipc" ? "named-pipe" : "unix-socket";
}

/**
 * `sockaddr_un.sun_path` is 104 bytes on darwin and 108 on Linux; Node fails
 * with an opaque `EINVAL` once the path (including the trailing NUL) overflows
 * it, so surface the limit as a structured error instead.
 */
export function localIpcPathLengthLimit(platform: NodeJS.Platform = process.platform) {
  return platform === "darwin" ? 103 : 107;
}

function assertEndpointPathFits(endpoint: LocalIpcEndpoint) {
  if (endpoint.transport !== "unix-socket") return;
  const limit = localIpcPathLengthLimit(endpoint.platform);
  if (Buffer.byteLength(endpoint.path) > limit) {
    throw endpointError(
      "LOCAL_IPC_PATH_TOO_LONG",
      `Local IPC socket path exceeds the ${limit}-byte limit on ${endpoint.platform}: ${endpoint.path}`,
    );
  }
}

function endpointHash(key: string, length: number) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, length);
}

function assertEndpointOptions(options: LocalIpcEndpointOptions) {
  if (typeof options.scope !== "string" || !options.scope.trim()) {
    throw endpointError("LOCAL_IPC_SCOPE_INVALID", "A local IPC endpoint requires a non-empty scope.");
  }
  if (typeof options.key !== "string" || !options.key.trim()) {
    throw endpointError("LOCAL_IPC_KEY_INVALID", "A local IPC endpoint requires a non-empty key.");
  }
  if (options.hashLength !== undefined && (!Number.isInteger(options.hashLength) || options.hashLength < 1 || options.hashLength > 64)) {
    throw endpointError("LOCAL_IPC_HASH_LENGTH_INVALID", "hashLength must be an integer between 1 and 64.");
  }
  if (options.explicitPath !== undefined && (!options.explicitPath.trim() || options.explicitPath.includes("\0"))) {
    throw endpointError("LOCAL_IPC_PATH_INVALID", "explicitPath must be a non-empty path without NUL bytes.");
  }
  if (options.directoryName !== undefined && (!options.directoryName.trim() || /[\/\\\0]/.test(options.directoryName))) {
    throw endpointError("LOCAL_IPC_DIRECTORY_NAME_INVALID", "directoryName must be a non-empty name without path separators or NUL bytes.");
  }
}

/**
 * Shared temporary root policy: `/private/tmp` on darwin so unix socket paths
 * stay inside `sun_path`, the real temporary directory everywhere else.
 */
export function localIpcTemporaryRoot(platform: NodeJS.Platform = process.platform, temporaryDirectory?: string) {
  if (platform === "darwin") return "/private/tmp";
  if (temporaryDirectory) return temporaryDirectory;
  const base = os.tmpdir();
  try {
    return fs.realpathSync(base);
  } catch {
    return base;
  }
}

function isNamedPipePath(value: string) {
  return /^\\\\[.?]\\pipe\\/i.test(value) || value.startsWith("//./pipe/");
}

/** The scope directory name shared by the POSIX path and the Windows pipe name. */
export function localIpcScopeName(scope: string, key: string, hashLength = 16) {
  assertEndpointOptions({ scope, key, hashLength });
  return `${scope}-${endpointHash(key, hashLength)}`;
}

function resolveScopeName(options: LocalIpcEndpointOptions) {
  return options.directoryName ?? localIpcScopeName(options.scope, options.key, options.hashLength ?? 16);
}

export function localIpcEndpoint(options: LocalIpcEndpointOptions): LocalIpcEndpoint {
  assertEndpointOptions(options);
  const platform = options.platform ?? process.platform;
  const kind = options.kind ?? "host-ipc";
  const generatedTransport = localIpcTransportFor(kind, platform);
  if (options.explicitPath) {
    const transport = isNamedPipePath(options.explicitPath) ? "named-pipe" : generatedTransport;
    return { path: options.explicitPath, transport, kind, platform, filesystemBacked: transport === "unix-socket" };
  }
  const scopeName = resolveScopeName(options);
  if (generatedTransport === "named-pipe") {
    return { path: `\\\\.\\pipe\\${scopeName}`, transport: generatedTransport, kind, platform, filesystemBacked: false };
  }
  const root = options.rootDir || localIpcTemporaryRoot(platform, options.temporaryDirectory);
  return {
    path: path.join(root, scopeName, options.fileName ?? "ipc.sock"),
    transport: generatedTransport,
    kind,
    platform,
    filesystemBacked: true,
  };
}

/**
 * POSIX hardening helper. Windows relies on the user-scoped ACL already carried
 * by `%TEMP%` / `%LOCALAPPDATA%`, so no ineffective `chmod` is attempted.
 */
export function restrictToCurrentUser(target: string, mode: number, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") return;
  fs.chmodSync(target, mode);
}

/**
 * Endpoint for an agent socket that sits directly inside a caller-owned
 * directory on POSIX. Windows has no filesystem entity for a socket, so only a
 * named pipe is derived from the scope; the directory keeps holding whatever
 * else the invocation needs (keys, known hosts, logs).
 */
export function localIpcEndpointInDirectory(
  directory: string,
  options: { scope: string; key: string; fileName?: string; platform?: NodeJS.Platform },
): LocalIpcEndpoint {
  assertEndpointOptions({ scope: options.scope, key: options.key });
  const platform = options.platform ?? process.platform;
  if (localIpcTransportFor("host-ipc", platform) === "named-pipe") {
    return {
      path: `\\\\.\\pipe\\${localIpcScopeName(options.scope, options.key)}`,
      transport: "named-pipe",
      kind: "host-ipc",
      platform,
      filesystemBacked: false,
    };
  }
  const endpoint: LocalIpcEndpoint = {
    path: path.join(directory, options.fileName ?? "ipc.sock"),
    transport: "unix-socket",
    kind: "host-ipc",
    platform,
    filesystemBacked: true,
  };
  assertEndpointPathFits(endpoint);
  return endpoint;
}

function removeStaleEndpointEntity(endpointPath: string) {
  try {
    fs.unlinkSync(endpointPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Creates the scope directory, tightens permissions and clears a stale entity. */
export function prepareLocalIpcEndpoint(endpoint: LocalIpcEndpoint, options: { mode?: number } = {}) {
  if (!endpoint.filesystemBacked) return;
  assertEndpointPathFits(endpoint);
  const mode = options.mode ?? 0o700;
  const directory = path.dirname(endpoint.path);
  fs.mkdirSync(directory, { recursive: true, mode });
  restrictToCurrentUser(directory, mode, endpoint.platform);
  removeStaleEndpointEntity(endpoint.path);
}

/** Removes the endpoint entity. Idempotent, and a no-op for named pipes. */
export function cleanupLocalIpcEndpoint(endpoint: LocalIpcEndpoint) {
  if (!endpoint.filesystemBacked) return;
  removeStaleEndpointEntity(endpoint.path);
}

function assertNodeConnectable(endpoint: LocalIpcEndpoint) {
  if (endpoint.kind === "codex-af-unix" && endpoint.platform === "win32") {
    throw endpointError(
      "LOCAL_IPC_PROXY_REQUIRED",
      "Codex AF_UNIX endpoints are reached through the CLI stdio proxy on Windows.",
    );
  }
}

export function connectLocalIpcEndpoint(endpoint: LocalIpcEndpoint): net.Socket {
  assertNodeConnectable(endpoint);
  assertEndpointPathFits(endpoint);
  return net.createConnection(endpoint.path);
}

export function listenOnLocalIpcEndpoint(server: net.Server, endpoint: LocalIpcEndpoint): Promise<void> {
  assertNodeConnectable(endpoint);
  assertEndpointPathFits(endpoint);
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint.path);
  });
}

/**
 * Creates a per-invocation endpoint. POSIX gets a fresh `mkdtemp` scope
 * directory; Windows gets a named pipe with a random suffix, because a pipe has
 * no directory to create.
 */
export function createLocalIpcTempEndpoint(
  options: Omit<LocalIpcEndpointOptions, "key" | "explicitPath"> & { key?: string; keyHashLength?: number },
): LocalIpcTempEndpoint {
  const platform = options.platform ?? process.platform;
  const kind = options.kind ?? "host-ipc";
  const scopeBase = options.directoryName
    ?? localIpcScopeName(options.scope, options.key ?? crypto.randomUUID(), options.keyHashLength ?? 12);
  const transport = localIpcTransportFor(kind, platform);
  if (transport === "named-pipe") {
    const unique = `${scopeBase}-${crypto.randomBytes(6).toString("hex")}`;
    return {
      endpoint: { path: `\\\\.\\pipe\\${unique}`, transport, kind, platform, filesystemBacked: false },
    };
  }
  const root = options.rootDir || localIpcTemporaryRoot(platform, options.temporaryDirectory);
  const directory = fs.mkdtempSync(path.join(root, `${scopeBase}-`));
  return {
    endpoint: {
      path: path.join(directory, options.fileName ?? "ipc.sock"),
      transport,
      kind,
      platform,
      filesystemBacked: true,
    },
    directory,
  };
}
