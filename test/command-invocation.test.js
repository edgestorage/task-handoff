const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  commandInvocation,
  isCommandInterpreterShim,
  quoteCommandInterpreterArgument,
  resolveCommandExecutable,
} = require("../packages/core/src/core/command-invocation.ts");

function shimDirectory(t, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-invocation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const entry of entries) {
    fs.writeFileSync(path.join(bin, entry), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return bin;
}

test("leaves a POSIX executable untouched", (t) => {
  const bin = shimDirectory(t, ["codex"]);
  const invocation = commandInvocation("codex", ["exec", "--json"], {
    env: { PATH: bin },
  });
  assert.equal(invocation.executable, path.join(bin, "codex"));
  assert.deepEqual(invocation.args, ["exec", "--json"]);
  assert.equal(invocation.interpreterWrapped, false);
});

test("wraps a win32 .cmd shim through ComSpec with call", (t) => {
  const bin = shimDirectory(t, ["opencode.cmd"]);
  const invocation = commandInvocation("opencode", ["serve", "--port=1234"], {
    env: { PATH: bin, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    platform: "win32",
  });
  assert.equal(invocation.interpreterWrapped, true);
  assert.equal(invocation.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/s", "/c", "call"]);
  assert.equal(path.dirname(invocation.args[4]), bin);
  assert.equal(path.basename(invocation.args[4]).toLowerCase(), "opencode.cmd");
  assert.deepEqual(invocation.args.slice(5), ["serve", "--port=1234"]);
});

test("wraps a win32 .bat shim and defaults to cmd.exe without ComSpec", (t) => {
  const bin = shimDirectory(t, ["legacy.bat"]);
  const invocation = commandInvocation("legacy", ["--flag"], { env: { PATH: bin, PATHEXT: ".BAT" }, platform: "win32" });
  assert.equal(invocation.executable, "cmd.exe");
  assert.deepEqual(invocation.args[0], "/d");
  assert.equal(path.dirname(invocation.args[4]), bin);
  assert.equal(path.basename(invocation.args[4]).toLowerCase(), "legacy.bat");
});

test("does not wrap a win32 .exe", (t) => {
  const bin = shimDirectory(t, ["codex.exe"]);
  const invocation = commandInvocation("codex", ["app-server"], { env: { PATH: bin, ComSpec: "cmd.exe" }, platform: "win32" });
  assert.equal(invocation.interpreterWrapped, false);
  assert.equal(path.dirname(invocation.executable), bin);
  assert.equal(path.basename(invocation.executable).toLowerCase(), "codex.exe");
  assert.deepEqual(invocation.args, ["app-server"]);
});

test("quotes arguments that cmd.exe would otherwise re-parse", () => {
  assert.equal(quoteCommandInterpreterArgument("plain"), "plain");
  assert.equal(quoteCommandInterpreterArgument(""), '""');
  assert.equal(quoteCommandInterpreterArgument("a b"), '"a b"');
  assert.equal(quoteCommandInterpreterArgument("a&b"), '"a&b"');
  assert.equal(quoteCommandInterpreterArgument("a|b"), '"a|b"');
  assert.equal(quoteCommandInterpreterArgument("a>b<c"), '"a>b<c"');
  assert.equal(quoteCommandInterpreterArgument("a(b)c"), '"a(b)c"');
  assert.equal(quoteCommandInterpreterArgument('say "hi"'), '"say \\"hi\\""');
});

test("rejects arguments cmd.exe cannot pass through safely", () => {
  assert.throws(() => quoteCommandInterpreterArgument("100%"), (error) => error.code === "COMMAND_ARGUMENT_UNSUPPORTED");
  assert.throws(() => quoteCommandInterpreterArgument("line\nbreak"), (error) => error.code === "COMMAND_ARGUMENT_INVALID");
  assert.throws(() => quoteCommandInterpreterArgument("nul\0byte"), (error) => error.code === "COMMAND_ARGUMENT_INVALID");
});

test("probing and launching share one resolution so success implies launchable", (t) => {
  const bin = shimDirectory(t, ["opencode.cmd"]);
  const env = { PATH: bin, ComSpec: "cmd.exe" };
  const options = { env, platform: "win32" };

  const probed = resolveCommandExecutable("opencode", options);
  const invocation = commandInvocation("opencode", ["run"], options);
  assert.equal(probed, invocation.args[4]);
  assert.equal(isCommandInterpreterShim(probed, "win32"), true);

  const missing = { PATH: path.join(path.dirname(bin), "empty") };
  assert.equal(resolveCommandExecutable("opencode", { env: missing, platform: "win32" }), undefined);
  const fallback = commandInvocation("opencode", ["run"], { env: missing, platform: "win32" });
  assert.equal(fallback.interpreterWrapped, false);
  assert.equal(fallback.executable, "opencode");
});

test("merges resolver environment additions into the invocation env", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-invocation-nvm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nvmBin = path.join(root, "nvm", "versions", "node", "v24.1.0", "bin");
  fs.mkdirSync(nvmBin, { recursive: true });
  fs.writeFileSync(path.join(nvmBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const invocation = commandInvocation("codex", [], {
    env: { PATH: "/missing", NVM_DIR: path.join(root, "nvm") },
    homeDir: root,
  });
  assert.equal(invocation.executable, path.join(nvmBin, "codex"));
  assert.equal(invocation.env.NVM_BIN, nvmBin);
  assert.equal(invocation.env.PATH, `${nvmBin}${path.delimiter}/missing`);
});

test("only opts into the win32 command-shim fallback when asked", () => {
  const missing = { PATH: "/task-handoff/definitely-missing", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  const options = { env: missing, platform: "win32", win32ShimWhenUnresolved: true };

  const fallback = commandInvocation("npm", ["install", "--global"], options);
  assert.equal(fallback.interpreterWrapped, true);
  assert.equal(fallback.executable, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(fallback.args, ["/d", "/s", "/c", "call", "npm.cmd", "install", "--global"]);

  // A name that already carries an extension is never guessed at, and POSIX
  // hosts keep the unresolved command so their PATH lookup still applies.
  assert.equal(commandInvocation("npm.exe", [], options).interpreterWrapped, false);
  assert.equal(commandInvocation("npm", [], { ...options, platform: "linux" }).executable, "npm");
  assert.equal(commandInvocation("npm", [], { env: missing, platform: "win32" }).executable, "npm");
});
