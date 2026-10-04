import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliProfileStore } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { SKILL_PROVENANCE_FILE, skillContentSignature } from "../src/skill.ts";
import {
  loadUpdateCheckState,
  maybeScheduleUpdateCheck,
  pendingUpdateNotice,
  runUpdateCheckChild,
  saveUpdateCheckState,
  updateCheckStatePath,
} from "../src/update-check.ts";

const HOUR = 3_600_000;
const SKILLS_INDEX_URL = "https://docs.test/.well-known/skills/index.json";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

function tempContext(env = {}) {
  const store = new CliProfileStore(tempDir("thctl-update-store-"));
  return { store, env };
}

function releaseFetch() {
  return async (url) => {
    const target = String(url);
    if (target === "https://registry.test/@task-handoff%2fthctl") {
      return new Response(JSON.stringify({ "dist-tags": { latest: "1.2.3", beta: "1.3.0-beta.1" } }), { status: 200 });
    }
    if (target === SKILLS_INDEX_URL) {
      return new Response(JSON.stringify({ skills: [{ name: "taskhandoff", version: "8", thctl: ">=0.0.20", files: ["SKILL.md"] }] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

function releaseEnv() {
  return {
    TASK_HANDOFF_CLI_REGISTRY: "https://registry.test/",
    TASK_HANDOFF_SKILLS_INDEX_URL: SKILLS_INDEX_URL,
  };
}

function installedSkill(cwd, version) {
  const directory = path.join(cwd, ".agents", "skills", "taskhandoff");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), `---\nname: taskhandoff\nmetadata:\n  version: "${version}"\n---\n`);
  return directory;
}

/** Managed copy with provenance, so the notice can compare content fingerprints. */
function installedManagedSkill(cwd, version) {
  const directory = installedSkill(cwd, version);
  const contents = fs.readFileSync(path.join(directory, "SKILL.md"));
  const files = { "SKILL.md": createHash("sha256").update(contents).digest("hex") };
  fs.writeFileSync(path.join(directory, SKILL_PROVENANCE_FILE), `${JSON.stringify({
    schemaVersion: 1,
    name: "taskhandoff",
    version,
    source: "index",
    indexUrl: SKILLS_INDEX_URL,
    installedAt: new Date().toISOString(),
    cliVersion: "1.0.0",
    files,
  }, null, 2)}\n`);
  return { directory, files, signature: skillContentSignature(files) };
}

test("background checks are scheduled once per interval and honour opt-outs", () => {
  const context = tempContext();
  const spawned = [];
  const spawnDetached = (execPath, args) => spawned.push({ execPath, args });
  const argv = ["node", "thctl", "profile", "list"];
  const now = Date.now();
  maybeScheduleUpdateCheck(context, { argv, now, spawnDetached });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].execPath, process.execPath);
  assert.deepEqual(spawned[0].args.slice(1), ["__update-check"]);

  maybeScheduleUpdateCheck(context, { argv, now: now + 60_000, spawnDetached });
  assert.equal(spawned.length, 1, "an attempt inside the throttle window must not spawn again");
  maybeScheduleUpdateCheck(context, { argv, now: now + 25 * HOUR, spawnDetached });
  assert.equal(spawned.length, 2);

  const flagOff = tempContext();
  maybeScheduleUpdateCheck(flagOff, { argv: ["node", "thctl", "--no-update-check"], spawnDetached });
  assert.equal(spawned.length, 2, "--no-update-check must disable scheduling");
  const envOff = tempContext({ TASK_HANDOFF_CLI_UPDATE_CHECK: "0" });
  maybeScheduleUpdateCheck(envOff, { argv, spawnDetached });
  assert.equal(spawned.length, 2, "TASK_HANDOFF_CLI_UPDATE_CHECK=0 must disable scheduling");
  const envOn = tempContext({ TASK_HANDOFF_CLI_UPDATE_CHECK: "1" });
  maybeScheduleUpdateCheck(envOn, { argv, spawnDetached });
  assert.equal(spawned.length, 3);
});

test("failed checks retry sooner and the interval override is honoured", () => {
  const context = tempContext();
  const spawned = [];
  const spawnDetached = () => spawned.push(true);
  const now = Date.now();
  const file = updateCheckStatePath(context);
  saveUpdateCheckState(file, { schemaVersion: 1, lastAttemptAt: new Date(now - 2 * HOUR).toISOString(), lastAttemptOk: false });
  maybeScheduleUpdateCheck(context, { argv: [], now, spawnDetached });
  assert.equal(spawned.length, 1, "a failed attempt retries after one hour");
  saveUpdateCheckState(file, { schemaVersion: 1, lastAttemptAt: new Date(now - 30 * 60_000).toISOString(), lastAttemptOk: false });
  maybeScheduleUpdateCheck(context, { argv: [], now, spawnDetached });
  assert.equal(spawned.length, 1, "a recent failure stays inside the retry window");

  const fast = tempContext({ TASK_HANDOFF_CLI_UPDATE_CHECK_INTERVAL: "60" });
  saveUpdateCheckState(updateCheckStatePath(fast), { schemaVersion: 1, lastAttemptAt: new Date(now - 2 * 60_000).toISOString(), lastAttemptOk: true });
  maybeScheduleUpdateCheck(fast, { argv: [], now, spawnDetached });
  assert.equal(spawned.length, 2, "the interval override shortens the success window");
});

test("the hidden update-check child records CLI and skill state without output", async () => {
  const context = tempContext();
  const streams = capture();
  const code = await runCli(["node", "thctl", "__update-check"], {
    store: context.store,
    streams: streams.streams,
    fetchImpl: releaseFetch(),
    env: releaseEnv(),
  });
  assert.equal(code, 0);
  assert.equal(streams.stdout(), "");
  assert.equal(streams.stderr(), "");
  const state = loadUpdateCheckState(updateCheckStatePath(context));
  assert.equal(state.cli.latestVersion, "1.2.3");
  assert.equal(state.cli.tag, "latest");
  assert.equal(state.cli.channel, "stable");
  assert.equal(state.skill.latestVersion, "8");
  assert.equal(state.skill.thctl, ">=0.0.20");
  assert.equal(state.lastAttemptOk, true);
});

test("runUpdateCheckChild tolerates one failing source and keeps the other", async () => {
  const context = tempContext();
  await runUpdateCheckChild({
    store: context.store,
    env: releaseEnv(),
    fetchImpl: async (url) => {
      if (String(url) === SKILLS_INDEX_URL) return new Response("boom", { status: 500 });
      return releaseFetch()(url);
    },
  });
  const state = loadUpdateCheckState(updateCheckStatePath(context));
  assert.equal(state.cli.latestVersion, "1.2.3");
  assert.equal(state.skill, undefined);
  assert.equal(state.lastAttemptOk, true);
});

test("pending notices only appear for interactive runs and are throttled", () => {
  const context = tempContext();
  const file = updateCheckStatePath(context);
  const now = Date.now();
  const cwd = tempDir("thctl-update-cwd-");
  const home = tempDir("thctl-update-home-");
  installedSkill(cwd, "5");
  saveUpdateCheckState(file, {
    schemaVersion: 1,
    cli: { latestVersion: "1.2.3", tag: "latest" },
    skill: { latestVersion: "8", thctl: ">=0.0.20" },
  });
  const interactive = { ...context, isTty: true, output: { json: false } };
  const notice = pendingUpdateNotice(interactive, { argv: [], now, cwd, home });
  assert.match(notice, /thctl 1\.0\.0 → 1\.2\.3 is available: npm install -g @task-handoff\/thctl@latest/);
  assert.match(notice, /skill taskhandoff 5 → 8 is available: thctl skill update/);
  assert.equal(pendingUpdateNotice(interactive, { argv: [], now: now + 60_000, cwd, home }), undefined, "the same notice is throttled for 24 hours");
  assert.match(pendingUpdateNotice(interactive, { argv: [], now: now + 25 * HOUR, cwd, home }) ?? "", /thctl 1\.0\.0 → 1\.2\.3/);

  assert.equal(pendingUpdateNotice({ ...interactive, isTty: false }, { argv: [], now, cwd, home }), undefined);
  assert.equal(pendingUpdateNotice({ ...interactive, output: { json: true } }, { argv: [], now, cwd, home }), undefined);
  const forced = pendingUpdateNotice(
    { ...context, isTty: false, output: { json: true }, env: { TASK_HANDOFF_CLI_UPDATE_CHECK: "1" } },
    { argv: [], now: now + 50 * HOUR, cwd, home },
  );
  assert.match(forced ?? "", /thctl 1\.0\.0 → 1\.2\.3/);

  const older = { ...context, isTty: true, output: { json: false } };
  saveUpdateCheckState(file, {
    schemaVersion: 1,
    cli: { latestVersion: "1.2.3", tag: "latest" },
    skill: { latestVersion: "8", thctl: ">=99.0.0" },
  });
  const blocked = pendingUpdateNotice(older, { argv: [], now, cwd, home });
  assert.match(blocked ?? "", /needs thctl >=99\.0\.0: update the CLI first/);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("skill notices compare published content instead of version order", () => {
  const context = tempContext();
  const file = updateCheckStatePath(context);
  const now = Date.now();
  const cwd = tempDir("thctl-update-cwd-");
  const home = tempDir("thctl-update-home-");
  const { signature } = installedManagedSkill(cwd, "20261004-aaaaaaaaaaaa");
  const interactive = { ...context, isTty: true, output: { json: false } };

  saveUpdateCheckState(file, {
    schemaVersion: 1,
    skill: { latestVersion: "20261005-bbbbbbbbbbbb", contentSignature: signature },
  });
  assert.equal(
    pendingUpdateNotice(interactive, { argv: [], now, cwd, home }),
    undefined,
    "identical content stays quiet even when the version label changed",
  );

  saveUpdateCheckState(file, {
    schemaVersion: 1,
    skill: { latestVersion: "20261005-bbbbbbbbbbbb", contentSignature: "0".repeat(64) },
  });
  assert.match(
    pendingUpdateNotice(interactive, { argv: [], now, cwd, home }) ?? "",
    /skill taskhandoff 20261004-aaaaaaaaaaaa → 20261005-bbbbbbbbbbbb is available: thctl skill update/,
  );
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

test("local builds stay quiet about registry releases unless the check is forced", () => {
  const context = tempContext();
  const file = updateCheckStatePath(context);
  const now = Date.now();
  saveUpdateCheckState(file, {
    schemaVersion: 1,
    cli: { latestVersion: "0.0.35", tag: "latest" },
  });
  const local = { ...context, isTty: true, output: { json: false } };
  assert.equal(pendingUpdateNotice(local, { argv: [], now, cwd: "/nonexistent", home: "/nonexistent", cliVersion: "0.0.25-local.1" }), undefined);
  const forced = {
    ...context,
    isTty: true,
    output: { json: false },
    env: { TASK_HANDOFF_CLI_UPDATE_CHECK: "1" },
  };
  assert.match(
    pendingUpdateNotice(forced, { argv: [], now, cwd: "/nonexistent", home: "/nonexistent", cliVersion: "0.0.25-local.1" }) ?? "",
    /thctl 0\.0\.25-local\.1 → 0\.0\.35 is available/,
  );
});

test("runCli prints the cached notice after a command and honours --no-update-check", async () => {
  const context = tempContext();
  saveUpdateCheckState(updateCheckStatePath(context), {
    schemaVersion: 1,
    cli: { latestVersion: "1.2.3", tag: "latest" },
  });
  const output = capture();
  const code = await runCli(["node", "thctl", "profile", "list"], {
    store: context.store,
    streams: output.streams,
    env: {},
    isTty: true,
    updateCheck: { enabled: true, spawnDetached: () => {}, now: Date.now },
  });
  assert.equal(code, 0, output.stderr());
  assert.match(output.stderr(), /thctl 1\.0\.0 → 1\.2\.3 is available/, output.stderr());

  const suppressed = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "list", "--no-update-check"], {
    store: context.store,
    streams: suppressed.streams,
    env: {},
    isTty: true,
    updateCheck: { enabled: true, spawnDetached: () => {}, now: Date.now },
  }), 0);
  assert.equal(suppressed.stderr(), "");

  const library = capture();
  assert.equal(await runCli(["node", "thctl", "profile", "list"], {
    store: context.store,
    streams: library.streams,
    env: {},
    isTty: true,
  }), 0);
  assert.equal(library.stderr(), "", "library calls stay quiet unless updateCheck is enabled");
});
