const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { resolveTerminalCommand } = require("../packages/control-plane/src/shared/process/terminal-command-runner.ts");

const DOCKER_BIN = "C:\\Program Files\\Docker\\Docker\\resources\\bin";
const DOCKER_EXE = path.win32.join(DOCKER_BIN, "docker.exe");

test("windows terminal commands resolve to a PATHEXT executable path", () => {
  const env = { PATH: `C:\\Windows\\system32;${DOCKER_BIN}`, PATHEXT: ".com;.exe;.bat;.cmd" };
  const isFile = (candidate) => candidate === DOCKER_EXE;
  assert.equal(resolveTerminalCommand("docker", { platform: "win32", env, isFile }), DOCKER_EXE);
});

test("windows terminal commands read Path when that is the inherited casing", () => {
  const env = { Path: DOCKER_BIN, PATHEXT: ".exe" };
  const isFile = (candidate) => candidate === DOCKER_EXE;
  assert.equal(resolveTerminalCommand("docker", { platform: "win32", env, isFile }), DOCKER_EXE);
});

test("windows terminal commands ignore shims that earlier Path entries shadow with", () => {
  const shimDirectory = "C:\\Users\\dev\\AppData\\Roaming\\npm";
  const env = { PATH: `${shimDirectory};${DOCKER_BIN}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const normalize = (candidate) => candidate.toLowerCase();
  const isFile = (candidate) => normalize(candidate) === normalize(path.win32.join(shimDirectory, "docker")) || normalize(candidate) === normalize(DOCKER_EXE);
  assert.equal(normalize(resolveTerminalCommand("docker", { platform: "win32", env, isFile })), normalize(DOCKER_EXE));
});

test("windows terminal commands keep a shim script as a last resort", () => {
  const shim = path.win32.join("C:\\tools", "docker.cmd");
  const env = { PATH: "C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const isFile = (candidate) => candidate.toLowerCase() === shim.toLowerCase();
  const resolved = resolveTerminalCommand("docker", { platform: "win32", env, isFile });
  assert.equal(resolved.toLowerCase(), shim.toLowerCase());
});

test("windows terminal commands that already carry an extension resolve exactly", () => {
  const env = { PATH: `${DOCKER_BIN};C:\\tools`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const isFile = (candidate) => candidate === DOCKER_EXE;
  assert.equal(resolveTerminalCommand("docker.exe", { platform: "win32", env, isFile }), DOCKER_EXE);
});

test("windows terminal commands pass through paths that already carry a directory", () => {
  const env = { PATH: DOCKER_BIN, PATHEXT: ".exe" };
  const isFile = () => true;
  assert.equal(resolveTerminalCommand("C:\\tools\\docker.exe", { platform: "win32", env, isFile }), "C:\\tools\\docker.exe");
  assert.equal(resolveTerminalCommand(".\\bin\\docker.exe", { platform: "win32", env, isFile }), ".\\bin\\docker.exe");
});

test("unresolved windows terminal commands are left for node-pty to report", () => {
  const env = { PATH: DOCKER_BIN, PATHEXT: ".exe" };
  assert.equal(resolveTerminalCommand("docker", { platform: "win32", env, isFile: () => false }), "docker");
});

test("non-windows terminal commands are never rewritten", () => {
  const env = { PATH: "/usr/local/bin", PATHEXT: ".EXE" };
  assert.equal(resolveTerminalCommand("docker", { platform: "darwin", env, isFile: () => true }), "docker");
  assert.equal(resolveTerminalCommand("docker", { platform: "linux", env, isFile: () => true }), "docker");
});
