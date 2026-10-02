import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLI_GROUPS, CLI_LEAVES, findLeaf } from "../src/contracts.ts";
import { exportContractDocument, renderContractMarkdown } from "../src/schema-export.ts";
import { CliProfileStore } from "../src/config.ts";
import { runCli } from "../src/program.ts";

const DECLARED_COMMANDS = [
  "profile add", "profile list", "profile use", "profile show", "profile remove", "profile trust", "login", "logout",
  "whoami", "instance list", "instance show", "instance create", "instance delete", "instance start",
  "instance stop", "instance restart", "instance logs", "instance rename", "ai-session list", "ai-session show",
  "ai-session history", "ai-session turns", "ai-session turn", "ai-session timeline", "ai-session turn-timeline",
  "ai-session create", "ai-session send", "ai-session interrupt", "ai-session approval", "ai-session resume",
  "ai-session read", "ai-session rename", "ai-session fork", "ai-session close", "ai-session model",
  "ai-session reasoning", "ai-session queue list", "ai-session queue steer", "ai-session queue retry",
  "ai-session queue remove", "ai-session queue edit", "ai-session queue reorder", "app-session list",
  "app-session show", "app-session start", "app-session stop", "app-session rename", "app-session access",
  "app-session restart", "node list", "node show", "node rename", "node create", "node remove", "node check",
  "node sync-local", "node folders list", "node folders tree", "node folders add", "node folders update",
  "node folders remove", "node runtimes list", "node runtimes create", "node runtimes update",
  "node runtimes remove", "node runtimes check", "node docker images", "node image-options",
  "node settings external-listener show", "node settings external-listener set", "node settings model-relay show",
  "node settings model-relay set", "node updates jobs", "node updates check", "node updates apply",
  "node pairing invite", "node pairings list", "node pairings remove", "node connections list",
  "node connections create", "node connections remove", "node-join invite", "node-join status", "node-join complete",
  "story list", "story show", "story create", "story update", "story archive", "story restore", "story remove",
  "story document update", "story document remove", "story document reorder", "story automation list",
  "story automation show", "story automation create", "story automation update", "story automation remove",
  "story automation enable", "story automation disable", "story automation run", "story automation runs",
  "trigger list", "trigger show", "trigger create", "trigger update", "trigger remove", "trigger run",
  "trigger bind", "trigger unbind", "trigger apply", "model list", "model show", "model create", "model copy",
  "model discover", "model test", "model reorder", "model update", "model sync", "model merge", "model remove",
  "model node list", "model node create", "model node update", "model node remove", "model node discover",
  "model node test", "project list", "project show", "project create", "project update", "project remove",
  "image list", "image show", "image create", "image update", "image remove", "image options", "market catalog",
  "market refresh", "env-template list", "env-template show", "env-template create", "env-template remove",
  "git-credential list", "git-credential show", "git-credential create", "git-credential update",
  "git-credential remove", "git-credential assignments list", "git-credential assignments assign",
  "git-credential assignments unassign", "chat status", "chat bridges list", "chat bridges create",
  "chat bridges update", "chat bridges start", "chat bridges stop", "chat bridges remove", "chat sessions list",
  "chat sessions show", "mobile-session list", "mobile-session revoke", "control-plane status",
  "control-plane settings show", "control-plane settings update", "control-plane diagnostic-logs export",
  "cloud show", "cloud challenge", "cloud remote-access", "cloud disconnect", "proxy invites list",
  "proxy invites create", "proxy invites remove", "proxy bindings list", "proxy bindings remove",
  "proxy diagnostics", "proxy pending-claims list", "proxy pending-claims resume", "proxy pending-claims remove",
  "user list", "user show", "user sessions", "user session-revoke", "user create", "user update", "user access",
  "user password-reset", "user role list", "user role create", "user role update", "user role remove",
  "user permission list", "user identity-provider list", "user identity-provider create",
  "user identity-provider update", "user identity-provider remove", "user external-identity list",
  "user external-identity approve", "user external-identity reject", "events", "schema",
];

function tempStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thctl-contracts-"));
  return new CliProfileStore(directory);
}

function capture() {
  const out = [];
  const err = [];
  return {
    streams: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

test("declared command surface matches the fixed contract", () => {
  const ids = CLI_LEAVES.map((leaf) => leaf.id);
  assert.deepEqual(ids, DECLARED_COMMANDS);
  assert.equal(new Set(ids).size, ids.length);
  for (const leaf of CLI_LEAVES) {
    assert.ok(leaf.summary.length > 0, `${leaf.id} needs a summary`);
    assert.ok(leaf.input, `${leaf.id} needs an input contract`);
    assert.ok(leaf.output, `${leaf.id} needs an output contract`);
    assert.match(leaf.stage, /^[ABC]$/);
  }
});

test("stage A, B and C commands are implemented except the explicitly planned instance logs", () => {
  const stageA = CLI_LEAVES.filter((leaf) => leaf.stage === "A").map((leaf) => leaf.id).sort();
  assert.deepEqual(stageA, [
    "ai-session list", "ai-session show", "instance list", "instance restart", "instance show",
    "instance start", "instance stop", "login", "logout", "profile add", "profile list",
    "profile remove", "profile show", "profile trust", "profile use", "schema", "whoami",
  ]);
  const stageB = CLI_LEAVES.filter((leaf) => leaf.stage === "B");
  assert.ok(stageB.length >= 30, `expected the declared stage B surface, saw ${stageB.length}`);
  const unimplemented = CLI_LEAVES.filter((leaf) => !leaf.handler);
  assert.deepEqual(unimplemented.map((leaf) => leaf.id), ["instance logs"], "only instance logs stays unimplemented");
  assert.equal(unimplemented[0].outputPinned, false, "instance logs must stay unpinned until implemented");
  const events = findLeaf("events");
  assert.equal(events.stage, "C");
  assert.ok(events.handler, "events must be implemented with the event stream work");
  assert.equal(events.outputMode, "json-lines");
  assert.equal(events.outputPinned, undefined);
});

test("schema export is generated from the same declarations as the command tree", () => {
  const document = exportContractDocument({ leaf: findLeaf("instance stop") });
  assert.equal(document.commands.length, 1);
  const [command] = document.commands;
  assert.equal(command.id, "instance stop");
  assert.equal(command.write, true);
  assert.equal(command.implemented, true);
  assert.deepEqual(command.arguments.map((arg) => arg.name), ["instanceId"]);
  assert.equal(command.outputSchema.type, "object");
  assert.deepEqual(Object.keys(command.outputSchema.properties).sort(), ["id", "status"]);
  assert.ok(command.inputSchema.properties.instanceId);
  const markdown = renderContractMarkdown(exportContractDocument({ group: "instance" }));
  assert.match(markdown, /### `instance stop`/);
  assert.match(markdown, /"type": "object"/);
  assert.equal(exportContractDocument().commands.length, DECLARED_COMMANDS.length);
});

test("unimplemented commands fail with the not-implemented exit code and never call the network", async () => {
  const output = capture();
  let fetched = 0;
  const code = await runCli(["node", "thctl", "instance", "logs", "instance_fake001"], {
    store: tempStore(),
    streams: output.streams,
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("network must not be used");
    },
    isTty: false,
  });
  assert.equal(code, 3);
  assert.match(output.stderr(), /CLI_COMMAND_NOT_IMPLEMENTED/);
  assert.match(output.stderr(), /stage C/);
  assert.equal(fetched, 0);
});

test("help lists implemented and unimplemented commands", async () => {
  const output = capture();
  const code = await runCli(["node", "thctl", "instance", "--help"], { store: tempStore(), streams: output.streams, isTty: false });
  assert.equal(code, 0);
  assert.match(output.stdout(), /list \[options\]\s+List controlled instances/);
  assert.match(output.stdout(), /logs \[options\] <instanceId>\s+Stream instance logs[\s\S]*not implemented\s+—\s+planned\s+stage\s+C/);
});

test("schema command writes matches to stdout and to --out files", async () => {
  const output = capture();
  const store = tempStore();
  const code = await runCli(["node", "thctl", "schema", "ai-session", "show"], { store, streams: output.streams, isTty: false });
  assert.equal(code, 0);
  const document = JSON.parse(output.stdout());
  assert.equal(document.commands.length, 1);
  assert.equal(document.commands[0].id, "ai-session show");

  const target = path.join(store.directory, "contract.md");
  const second = capture();
  const writeCode = await runCli(["node", "thctl", "schema", "--format", "md", "--out", target], { store, streams: second.streams, isTty: false });
  assert.equal(writeCode, 0);
  assert.match(fs.readFileSync(target, "utf8"), /# thctl contract/);

  const unknown = capture();
  const unknownCode = await runCli(["node", "thctl", "schema", "nope", "nope"], { store, streams: unknown.streams, isTty: false });
  assert.equal(unknownCode, 7);
  assert.match(unknown.stderr(), /CLI_SCHEMA_TARGET_UNKNOWN/);
});

test("flat groups register top-level commands without a duplicate parent", () => {
  const names = CLI_GROUPS.filter((group) => group.flat).map((group) => group.name);
  assert.deepEqual(names, ["auth", "events", "schema"]);
  for (const name of names) {
    const group = CLI_GROUPS.find((entry) => entry.name === name);
    assert.ok(group);
    for (const leaf of group.leaves) {
      assert.equal(leaf.name.includes(" "), false, `${leaf.id} must be a top-level command`);
    }
  }
});
