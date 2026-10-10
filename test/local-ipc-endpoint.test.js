const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cleanupLocalIpcEndpoint,
  connectLocalIpcEndpoint,
  createLocalIpcTempEndpoint,
  listenOnLocalIpcEndpoint,
  localIpcEndpointInDirectory,
  localIpcEndpoint,
  localIpcScopeName,
  localIpcTemporaryRoot,
  localIpcTransportFor,
  prepareLocalIpcEndpoint,
  restrictToCurrentUser,
} = require("../packages/core/src/core/local-ipc-endpoint.ts");

test("agent sockets sit inside a caller-owned directory on POSIX and become named pipes on Windows", () => {
  const directory = "/tmp/task-handoff-agent-invocation";
  const posix = localIpcEndpointInDirectory(directory, { scope: "task-handoff-git-agent", key: "invocation_one", fileName: "agent.sock", platform: "linux" });
  assert.equal(posix.path, path.join(directory, "agent.sock"));
  assert.equal(posix.transport, "unix-socket");
  assert.equal(posix.filesystemBacked, true);

  const windows = localIpcEndpointInDirectory(directory, { scope: "task-handoff-git-agent", key: "invocation_one", fileName: "agent.sock", platform: "win32" });
  assert.equal(windows.transport, "named-pipe");
  assert.equal(windows.filesystemBacked, false);
  assert.match(windows.path, /^\\\\.\\pipe\\task-handoff-git-agent-[a-f0-9]{16}$/);
  // The same key resolves to the same pipe, so a retry cannot land on a stale name.
  assert.equal(localIpcEndpointInDirectory(directory, { scope: "task-handoff-git-agent", key: "invocation_one", fileName: "agent.sock", platform: "win32" }).path, windows.path);
});

test("an agent socket that would overflow sun_path fails before a bind", () => {
  assert.throws(
    () => localIpcEndpointInDirectory(`/${"x".repeat(120)}`, { scope: "task-handoff-git-agent", key: "k", platform: "darwin" }),
    (error) => error.code === "LOCAL_IPC_PATH_TOO_LONG",
  );
});

test("the shared temporary root keeps sockets out of the long macOS temporary path", () => {
  assert.equal(localIpcTemporaryRoot("darwin"), "/private/tmp");
  assert.equal(localIpcTemporaryRoot("linux", "/short-tmp"), "/short-tmp");
});

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ipc-test-"));
}

// unix socket paths are capped at ~103 bytes, so the live round-trip test needs
// a short root rather than os.tmpdir().
function shortTemporaryRoot() {
  const base = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  return fs.mkdtempSync(path.join(base, "th-ipc-"));
}

test("resolves a POSIX unix socket path and keeps the legacy codex layout unchanged", (t) => {
  const root = shortTemporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = path.join(root, "runtime", "codex-app-server");
  const endpoint = localIpcEndpoint({
    scope: "task-handoff-codex",
    key,
    fileName: "app-server.sock",
    platform: "linux",
    temporaryDirectory: root,
  });
  const legacyHash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  assert.equal(endpoint.path, path.join(root, `task-handoff-codex-${legacyHash}`, "app-server.sock"));
  assert.equal(endpoint.transport, "unix-socket");
  assert.equal(endpoint.kind, "host-ipc");
  assert.equal(endpoint.filesystemBacked, true);
});

test("defaults the POSIX root to /private/tmp on darwin and os.tmpdir() elsewhere", () => {
  const darwin = localIpcEndpoint({ scope: "task-handoff-codex", key: "abc", platform: "darwin" });
  assert.equal(darwin.path.startsWith("/private/tmp/task-handoff-codex-"), true);
  assert.equal(darwin.filesystemBacked, true);
});

test("resolves a Windows named pipe for host IPC endpoints", () => {
  const endpoint = localIpcEndpoint({ scope: "task-handoff-git-proxy", key: "1234", platform: "win32" });
  const hash = crypto.createHash("sha256").update("1234").digest("hex").slice(0, 16);
  assert.equal(endpoint.path, `\\\\.\\pipe\\task-handoff-git-proxy-${hash}`);
  assert.equal(endpoint.transport, "named-pipe");
  assert.equal(endpoint.filesystemBacked, false);
});

test("keeps AF_UNIX for codex endpoints on win32 because the CLI proxy bridges them", () => {
  const root = shortTemporaryRoot();
  const endpoint = localIpcEndpoint({
    kind: "codex-af-unix",
    scope: "task-handoff-codex",
    key: "abc",
    fileName: "app-server.sock",
    platform: "win32",
    rootDir: root,
  });
  assert.equal(endpoint.transport, "unix-socket");
  assert.equal(endpoint.filesystemBacked, true);
  assert.equal(endpoint.path.startsWith("\\\\.\\pipe\\"), false);
  assert.equal(path.basename(endpoint.path), "app-server.sock");
});

test("honors an explicit path override and detects pipe form", () => {
  const explicit = localIpcEndpoint({
    scope: "task-handoff-git-proxy",
    key: "ignored",
    explicitPath: "/run/user/1000/task-handoff/broker.sock",
    platform: "linux",
  });
  assert.equal(explicit.path, "/run/user/1000/task-handoff/broker.sock");
  assert.equal(explicit.transport, "unix-socket");

  const injectedPipe = localIpcEndpoint({
    scope: "task-handoff-git-proxy",
    key: "ignored",
    explicitPath: "\\\\.\\pipe\\custom-task-handoff-broker",
    platform: "win32",
  });
  assert.equal(injectedPipe.transport, "named-pipe");
  assert.equal(injectedPipe.filesystemBacked, false);
});

test("prepare creates the scope directory with owner-only mode and clears a stale entity", (t) => {
  const root = shortTemporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const endpoint = localIpcEndpoint({
    scope: "task-handoff-codex",
    key: "stale",
    fileName: "app-server.sock",
    platform: "linux",
    temporaryDirectory: root,
  });
  fs.mkdirSync(path.dirname(endpoint.path), { recursive: true, mode: 0o755 });
  fs.writeFileSync(endpoint.path, "stale");
  prepareLocalIpcEndpoint(endpoint);
  assert.equal(fs.existsSync(endpoint.path), false);
  assert.equal(fs.statSync(path.dirname(endpoint.path)).mode & 0o777, 0o700);
  prepareLocalIpcEndpoint(endpoint);
  assert.equal(fs.existsSync(endpoint.path), false);
});

test("prepare and cleanup are no-ops for named pipes", (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const endpoint = localIpcEndpoint({ scope: "task-handoff-git-proxy", key: "42", platform: "win32", temporaryDirectory: root });
  prepareLocalIpcEndpoint(endpoint);
  cleanupLocalIpcEndpoint(endpoint);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("cleanup is idempotent for missing entities", (t) => {
  const root = shortTemporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const endpoint = localIpcEndpoint({
    scope: "task-handoff-git-proxy",
    key: "gone",
    fileName: "broker.sock",
    platform: "linux",
    temporaryDirectory: root,
  });
  cleanupLocalIpcEndpoint(endpoint);
  cleanupLocalIpcEndpoint(endpoint);
  assert.equal(fs.existsSync(endpoint.path), false);
});

test("restrictToCurrentUser is a no-op on win32 and tightens POSIX modes", (t) => {
  const root = temporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  restrictToCurrentUser(root, 0o700, "win32");
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  fs.chmodSync(root, 0o755);
  restrictToCurrentUser(root, 0o700, "linux");
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
});

test("refuses to connect to a codex AF_UNIX endpoint through Node on win32", () => {
  const endpoint = localIpcEndpoint({ kind: "codex-af-unix", scope: "task-handoff-codex", key: "abc", platform: "win32", rootDir: os.tmpdir() });
  assert.throws(() => connectLocalIpcEndpoint(endpoint), (error) => error.code === "LOCAL_IPC_PROXY_REQUIRED");
});

test("rejects invalid endpoint inputs", () => {
  assert.throws(() => localIpcEndpoint({ scope: "", key: "k" }), (error) => error.code === "LOCAL_IPC_SCOPE_INVALID");
  assert.throws(() => localIpcEndpoint({ scope: "s", key: " " }), (error) => error.code === "LOCAL_IPC_KEY_INVALID");
  assert.throws(() => localIpcEndpoint({ scope: "s", key: "k", hashLength: 0 }), (error) => error.code === "LOCAL_IPC_HASH_LENGTH_INVALID");
  assert.throws(() => localIpcEndpoint({ scope: "s", key: "k", hashLength: 65 }), (error) => error.code === "LOCAL_IPC_HASH_LENGTH_INVALID");
  assert.throws(() => localIpcEndpoint({ scope: "s", key: "k", explicitPath: "\0bad" }), (error) => error.code === "LOCAL_IPC_PATH_INVALID");
});

test("transport selection is explicit and platform driven", () => {
  assert.equal(localIpcTransportFor("host-ipc", "win32"), "named-pipe");
  assert.equal(localIpcTransportFor("host-ipc", "linux"), "unix-socket");
  assert.equal(localIpcTransportFor("codex-af-unix", "win32"), "unix-socket");
  assert.equal(localIpcScopeName("task-handoff-codex", "k", 8), `task-handoff-codex-${crypto.createHash("sha256").update("k").digest("hex").slice(0, 8)}`);
});

test("reports an over-long unix socket path instead of an opaque EINVAL", () => {
  const longRoot = path.join(os.tmpdir(), "x".repeat(80));
  const endpoint = localIpcEndpoint({ scope: "task-handoff-codex", key: "abc", fileName: "app-server.sock", platform: "darwin", rootDir: longRoot });
  assert.throws(
    () => prepareLocalIpcEndpoint(endpoint),
    (error) => error.code === "LOCAL_IPC_PATH_TOO_LONG",
  );
  assert.throws(() => connectLocalIpcEndpoint(endpoint), (error) => error.code === "LOCAL_IPC_PATH_TOO_LONG");
});

test("temp endpoints use a fresh POSIX directory and a unique named pipe", (t) => {
  const root = shortTemporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const posix = createLocalIpcTempEndpoint({
    scope: "th-git",
    key: "instance-1",
    fileName: "broker.sock",
    platform: "linux",
    temporaryDirectory: root,
  });
  assert.equal(posix.directory.startsWith(path.join(root, "th-git-")), true);
  assert.equal(path.dirname(posix.endpoint.path), posix.directory);
  assert.equal(path.basename(posix.endpoint.path), "broker.sock");

  const first = createLocalIpcTempEndpoint({ scope: "th-git", key: "instance-1", platform: "win32" });
  const second = createLocalIpcTempEndpoint({ scope: "th-git", key: "instance-1", platform: "win32" });
  assert.equal(first.endpoint.transport, "named-pipe");
  assert.equal(first.endpoint.path.startsWith("\\\\.\\pipe\\th-git-"), true);
  assert.notEqual(first.endpoint.path, second.endpoint.path);
  assert.equal(first.directory, undefined);
});

test("listen and connect round-trip over a POSIX unix socket", async (t) => {
  const root = shortTemporaryRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const endpoint = localIpcEndpoint({
    scope: "task-handoff-codex",
    key: "round-trip",
    fileName: "app-server.sock",
    platform: "linux",
    temporaryDirectory: root,
  });
  prepareLocalIpcEndpoint(endpoint);
  const server = net.createServer((socket) => socket.end("ok"));
  await listenOnLocalIpcEndpoint(server, endpoint);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const received = await new Promise((resolve, reject) => {
    const socket = connectLocalIpcEndpoint(endpoint);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("error", reject);
    socket.on("end", () => resolve(data));
  });
  assert.equal(received, "ok");
  cleanupLocalIpcEndpoint(endpoint);
});
