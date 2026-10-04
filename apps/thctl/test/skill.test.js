import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CliProfileStore } from "../src/config.ts";
import { runCli } from "../src/program.ts";
import { SKILL_PROVENANCE_FILE, satisfiesSkillRange } from "../src/skill.ts";

const INDEX_URL = "https://docs.test/.well-known/skills/index.json";
const INDEX_BASE = "https://docs.test/.well-known/skills/";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function releaseFiles(version) {
  return {
    "SKILL.md": `---\nname: taskhandoff\ndescription: TaskHandoff Agent Skill\nmetadata:\n  version: "${version}"\n---\n\n# TaskHandoff\n\nLoad the references on demand.\n`,
    "references/nodes.md": `# Nodes ${version}\n`,
  };
}

function createSkillServer({ version = "7", thctl = ">=0.0.20", integrity, files, document } = {}) {
  const contents = files ?? releaseFiles(version);
  const digests = integrity ?? Object.fromEntries(Object.entries(contents).map(([name, body]) => [name, sha256(body)]));
  const index = document ?? {
    skills: [{
      name: "taskhandoff",
      description: "TaskHandoff Agent Skill",
      version,
      thctl,
      files: Object.keys(contents),
      integrity: digests,
    }],
  };
  const requests = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    requests.push(target);
    if (target === INDEX_URL) {
      return new Response(JSON.stringify(index), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (target.startsWith(INDEX_BASE)) {
      const relative = decodeURIComponent(target.slice(INDEX_BASE.length));
      if (relative in contents) return new Response(contents[relative], { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, requests };
}

function capture() {
  const out = [];
  const err = [];
  return { streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tempStore() {
  return new CliProfileStore(tempDir("thctl-skill-store-"));
}

function env() {
  return { TASK_HANDOFF_SKILLS_INDEX_URL: INDEX_URL };
}

function provenanceOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "taskhandoff", SKILL_PROVENANCE_FILE), "utf8"));
}

async function runSkill(args, options) {
  const output = capture();
  const code = await runCli(["node", "thctl", "skill", ...args], {
    store: options.store ?? tempStore(),
    streams: output.streams,
    fetchImpl: options.fetchImpl,
    env: options.env ?? env(),
    isTty: options.isTty ?? false,
  });
  return { code, ...output };
}

test("skill install writes the published release with verified provenance", async () => {
  const root = tempDir("thctl-skill-root-");
  const server = createSkillServer({ version: "7" });
  const result = await runSkill(["install", "--dir", root, "--yes", "--json"], { fetchImpl: server.fetchImpl });
  assert.equal(result.code, 0, result.stderr());
  const installed = JSON.parse(result.stdout());
  assert.equal(installed.name, "taskhandoff");
  assert.equal(installed.version, "7");
  assert.equal(installed.verified, true);
  const skillFile = fs.readFileSync(path.join(root, "taskhandoff", "SKILL.md"), "utf8");
  assert.match(skillFile, /metadata:\n  version: "7"/);
  assert.equal(fs.readFileSync(path.join(root, "taskhandoff", "references", "nodes.md"), "utf8"), "# Nodes 7\n");
  const provenance = provenanceOf(root);
  assert.equal(provenance.version, "7");
  assert.equal(provenance.verified, true);
  assert.equal(provenance.files["SKILL.md"], sha256(releaseFiles("7")["SKILL.md"]));
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill install refuses an existing copy and dry-run writes nothing", async () => {
  const root = tempDir("thctl-skill-root-");
  const server = createSkillServer({ version: "7" });
  const dry = await runSkill(["install", "--dir", root, "--dry-run"], { fetchImpl: server.fetchImpl });
  assert.equal(dry.code, 0, dry.stderr());
  assert.equal(fs.existsSync(path.join(root, "taskhandoff")), false);
  assert.equal(await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: server.fetchImpl }).then((result) => result.code), 0);
  const conflict = await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: server.fetchImpl });
  assert.equal(conflict.code, 8, conflict.stderr());
  assert.match(conflict.stderr(), /CLI_SKILL_ALREADY_INSTALLED/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill install demands confirmation on a non-interactive terminal", async () => {
  const root = tempDir("thctl-skill-root-");
  const server = createSkillServer({ version: "7" });
  const result = await runSkill(["install", "--dir", root], { fetchImpl: server.fetchImpl });
  assert.equal(result.code, 4, result.stderr());
  assert.equal(fs.existsSync(path.join(root, "taskhandoff")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill status reports update-available and current across an update", async () => {
  const root = tempDir("thctl-skill-root-");
  const installed = createSkillServer({ version: "7" });
  assert.equal(await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: installed.fetchImpl }).then((result) => result.code), 0);

  const published = createSkillServer({ version: "8" });
  const outdated = await runSkill(["status", "--dir", root, "--json"], { fetchImpl: published.fetchImpl });
  assert.equal(outdated.code, 0, outdated.stderr());
  const [row] = JSON.parse(outdated.stdout());
  assert.equal(row.status, "update-available");
  assert.equal(row.version, "7");
  assert.equal(row.latestVersion, "8");
  assert.equal(row.command, `thctl skill update --dir ${root}`);

  const updated = await runSkill(["update", "--dir", root, "--yes", "--json"], { fetchImpl: published.fetchImpl });
  assert.equal(updated.code, 0, updated.stderr());
  assert.equal(JSON.parse(updated.stdout()).from, "7");
  assert.equal(JSON.parse(updated.stdout()).version, "8");
  assert.equal(provenanceOf(root).version, "8");

  const current = await runSkill(["status", "--dir", root, "--json"], { fetchImpl: published.fetchImpl });
  assert.equal(JSON.parse(current.stdout())[0].status, "current");
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill update is a no-op at the published version", async () => {
  const root = tempDir("thctl-skill-root-");
  const server = createSkillServer({ version: "7" });
  assert.equal(await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: server.fetchImpl }).then((result) => result.code), 0);
  const result = await runSkill(["update", "--dir", root, "--yes"], { fetchImpl: server.fetchImpl });
  assert.equal(result.code, 0, result.stderr());
  assert.match(result.stdout(), /already at 7/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill status and update compare published content, not version order", async () => {
  const root = tempDir("thctl-skill-root-");
  const released = "20261004-aaaaaaaaaaaa";
  const installed = createSkillServer({ version: released });
  assert.equal(await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: installed.fetchImpl }).then((result) => result.code), 0);

  // Same content republished under a newer label: nothing to do, no ordering involved.
  const relabelled = createSkillServer({ version: "20261005-bbbbbbbbbbbb", files: releaseFiles(released) });
  const current = await runSkill(["status", "--dir", root, "--json"], { fetchImpl: relabelled.fetchImpl });
  assert.equal(JSON.parse(current.stdout())[0].status, "current");
  assert.equal(JSON.parse(current.stdout())[0].latestVersion, "20261005-bbbbbbbbbbbb");
  const noop = await runSkill(["update", "--dir", root, "--yes"], { fetchImpl: relabelled.fetchImpl });
  assert.equal(noop.code, 0, noop.stderr());
  assert.match(noop.stdout(), /already at 20261004-aaaaaaaaaaaa/);

  // Same label with different content must still update, because content is the source of truth.
  const edited = createSkillServer({
    version: released,
    files: { ...releaseFiles(released), "references/nodes.md": "# Nodes 20261004-aaaaaaaaaaaa edited\n" },
  });
  const outdated = await runSkill(["status", "--dir", root, "--json"], { fetchImpl: edited.fetchImpl });
  assert.equal(JSON.parse(outdated.stdout())[0].status, "update-available");
  const updated = await runSkill(["update", "--dir", root, "--yes"], { fetchImpl: edited.fetchImpl });
  assert.equal(updated.code, 0, updated.stderr());
  assert.match(updated.stdout(), /Updated skill/);
  assert.equal(fs.readFileSync(path.join(root, "taskhandoff", "references", "nodes.md"), "utf8"), "# Nodes 20261004-aaaaaaaaaaaa edited\n");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an index without integrity falls back to version comparison", async () => {
  const root = tempDir("thctl-skill-root-");
  const installed = createSkillServer({ version: "7" });
  assert.equal(await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: installed.fetchImpl }).then((result) => result.code), 0);
  const legacyIndex = createSkillServer({
    document: { skills: [{ name: "taskhandoff", version: "8", thctl: ">=0.0.20", files: ["SKILL.md", "references/nodes.md"] }] },
  });
  const status = await runSkill(["status", "--dir", root, "--json"], { fetchImpl: legacyIndex.fetchImpl });
  assert.equal(JSON.parse(status.stdout())[0].status, "update-available");
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill update stops on local modifications and --force replaces them", async () => {
  const root = tempDir("thctl-skill-root-");
  const installed = createSkillServer({ version: "7" });
  assert.equal(await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: installed.fetchImpl }).then((result) => result.code), 0);
  const reference = path.join(root, "taskhandoff", "references", "nodes.md");
  fs.writeFileSync(reference, "# locally edited\n");

  const published = createSkillServer({ version: "8" });
  const blocked = await runSkill(["update", "--dir", root, "--yes"], { fetchImpl: published.fetchImpl });
  assert.equal(blocked.code, 8, blocked.stderr());
  assert.match(blocked.stderr(), /CLI_SKILL_LOCALLY_MODIFIED/);
  assert.equal(fs.readFileSync(reference, "utf8"), "# locally edited\n");

  const forced = await runSkill(["update", "--dir", root, "--yes", "--force"], { fetchImpl: published.fetchImpl });
  assert.equal(forced.code, 0, forced.stderr());
  assert.equal(fs.readFileSync(reference, "utf8"), "# Nodes 8\n");
  assert.equal(provenanceOf(root).version, "8");
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill releases that require a newer CLI fail with the capability exit code", async () => {
  const root = tempDir("thctl-skill-root-");
  const server = createSkillServer({ version: "9", thctl: ">=99.0.0" });
  const install = await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: server.fetchImpl });
  assert.equal(install.code, 14, install.stderr());
  assert.match(install.stderr(), /CLI_SKILL_REQUIRES_NEWER_CLI/);
  assert.equal(fs.existsSync(path.join(root, "taskhandoff")), false);

  const compatible = createSkillServer({ version: "7" });
  assert.equal(await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: compatible.fetchImpl }).then((result) => result.code), 0);
  const status = await runSkill(["status", "--dir", root, "--json"], { fetchImpl: server.fetchImpl });
  const [row] = JSON.parse(status.stdout());
  assert.equal(row.status, "cli-too-old");
  assert.equal(row.latestVersion, "9");
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill install rejects corrupted integrity and unsafe paths before writing", async () => {
  const root = tempDir("thctl-skill-root-");
  const broken = createSkillServer({ version: "7", integrity: { "SKILL.md": "0".repeat(64), "references/nodes.md": "1".repeat(64) } });
  const corrupt = await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: broken.fetchImpl });
  assert.equal(corrupt.code, 11, corrupt.stderr());
  assert.match(corrupt.stderr(), /sha256/);
  assert.equal(fs.existsSync(path.join(root, "taskhandoff")), false);

  const traversing = createSkillServer({ version: "7", files: { "SKILL.md": releaseFiles("7")["SKILL.md"], "../escape.md": "# escape\n" } });
  const unsafe = await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: traversing.fetchImpl });
  assert.equal(unsafe.code, 11, unsafe.stderr());
  assert.equal(fs.existsSync(path.join(root, "escape.md")), false);
  assert.equal(fs.existsSync(path.join(root, "taskhandoff")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an index without the taskhandoff entry is a protocol error", async () => {
  const root = tempDir("thctl-skill-root-");
  const server = createSkillServer({
    document: { skills: [{ name: "task-handoff", version: "5", files: ["SKILL.md"] }] },
  });
  const result = await runSkill(["install", "--dir", root, "--yes"], { fetchImpl: server.fetchImpl });
  assert.equal(result.code, 11, result.stderr());
  assert.match(result.stderr(), /taskhandoff/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill status reports legacy-name directories for migration", async () => {
  const root = tempDir("thctl-skill-root-");
  const legacy = path.join(root, "task-handoff");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "SKILL.md"), `---\nname: task-handoff\nmetadata:\n  version: "5"\n---\n`);
  const server = createSkillServer({ version: "8" });
  const result = await runSkill(["status", "--dir", root, "--json"], { fetchImpl: server.fetchImpl });
  assert.equal(result.code, 0, result.stderr());
  const rows = JSON.parse(result.stdout());
  const legacyRow = rows.find((row) => row.status === "legacy-name");
  assert.ok(legacyRow, `expected a legacy-name row, saw ${result.stdout()}`);
  assert.equal(legacyRow.directory, legacy);
  assert.equal(legacyRow.version, "5");
  fs.rmSync(root, { recursive: true, force: true });
});

test("skill install defaults to the user scope while project scope stays opt-in", async () => {
  const home = tempDir("thctl-skill-home-");
  const cwd = tempDir("thctl-skill-cwd-");
  const previousHome = process.env.HOME;
  const previous = process.cwd();
  const server = createSkillServer({ version: "7" });
  try {
    process.env.HOME = home;
    process.chdir(cwd);
    const missing = await runSkill(["update"], { fetchImpl: server.fetchImpl });
    assert.equal(missing.code, 7, missing.stderr());
    assert.ok(
      missing.stderr().includes(path.join(home, ".agents", "skills", "taskhandoff")),
      `default scope must resolve to the user directory: ${missing.stderr()}`,
    );
    const userInstall = await runSkill(["install", "--yes"], { fetchImpl: server.fetchImpl });
    assert.equal(userInstall.code, 0, userInstall.stderr());
    assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "taskhandoff", "SKILL.md")));
    assert.equal(fs.existsSync(path.join(cwd, ".agents")), false);

    const projectInstall = await runSkill(["install", "--scope", "project", "--yes"], { fetchImpl: server.fetchImpl });
    assert.equal(projectInstall.code, 0, projectInstall.stderr());
    assert.ok(fs.existsSync(path.join(cwd, ".agents", "skills", "taskhandoff", "SKILL.md")));

    const status = await runSkill(["status", "--json"], { fetchImpl: server.fetchImpl });
    const rows = JSON.parse(status.stdout());
    assert.deepEqual(rows.map((row) => row.scope), ["user", "project"]);
    assert.deepEqual(rows.map((row) => row.status), ["current", "current"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.chdir(previous);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("published thctl ranges gate release builds and skip local builds", () => {
  assert.equal(satisfiesSkillRange("0.0.36", ">=0.0.36"), true);
  assert.equal(satisfiesSkillRange("0.0.35", ">=0.0.36"), false);
  assert.equal(satisfiesSkillRange("0.0.36-beta.1", ">=0.0.36"), false);
  assert.equal(satisfiesSkillRange("0.0.25-local.20261004.1", ">=0.0.36"), true);
  assert.equal(satisfiesSkillRange("0.0.1", undefined), true);
});
