import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fetchNpmDistTagVersion,
  isNewerSkillVersion,
  isNewerVersion,
  isReleaseChannelVersion,
  isValidVersionRange,
  npmPackageUrl,
  normalizeRegistryUrl,
  registryTagForChannel,
  resolveNpmRegistry,
  satisfiesRange,
  updateChannelForVersion,
} from "../src/release.ts";

test("update channels route stable, beta and alpha builds to their dist-tags", () => {
  assert.equal(updateChannelForVersion("1.2.3"), "stable");
  assert.equal(updateChannelForVersion("1.2.3-beta.1"), "beta");
  assert.equal(updateChannelForVersion("1.2.3-alpha.20261004.1"), "alpha");
  assert.equal(registryTagForChannel("stable"), "latest");
  assert.equal(registryTagForChannel("beta"), "beta");
  assert.equal(registryTagForChannel("alpha"), "alpha");
});

test("only release-channel builds participate in registry updates", () => {
  assert.equal(isReleaseChannelVersion("1.2.3"), true);
  assert.equal(isReleaseChannelVersion("1.2.3-beta.1"), true);
  assert.equal(isReleaseChannelVersion("1.2.3-alpha.1"), true);
  assert.equal(isReleaseChannelVersion("1.2.3-local.20261004.1"), false);
  assert.equal(isReleaseChannelVersion("not-a-version"), false);
});

test("version comparison never suggests a downgrade for local or prerelease builds", () => {
  assert.equal(isNewerVersion("1.0.0", "1.0.1"), true);
  assert.equal(isNewerVersion("1.0.1", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0", "2.0.0-beta.1"), true);
  assert.equal(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1"), false);
  assert.equal(isNewerVersion("1.0.0-local.1", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0-local.1", "1.0.0-local.2"), true);
  assert.equal(isNewerVersion("1.0.0-beta.1", "1.0.0"), true);
  assert.equal(isNewerVersion("dev", "1.0.1"), false);
  assert.equal(isNewerVersion(undefined, "1.0.1"), false);
});

test("skill content versions compare numeric revisions first, then semver", () => {
  assert.equal(isNewerSkillVersion("5", "6"), true);
  assert.equal(isNewerSkillVersion("6", "5"), false);
  assert.equal(isNewerSkillVersion("5", "5"), false);
  assert.equal(isNewerSkillVersion("7", "10"), true);
  assert.equal(isNewerSkillVersion("1.0.0", "1.1.0"), true);
  assert.equal(isNewerSkillVersion("1.0.0", "1.0.0-beta.1"), false);
  assert.equal(isNewerSkillVersion("5", "next"), false);
});

test("skill compatibility ranges reject invalid declarations", () => {
  assert.equal(isValidVersionRange(">=0.0.20"), true);
  assert.equal(isValidVersionRange("not a range"), false);
  assert.equal(satisfiesRange("1.0.0", ">=0.0.20"), true);
  assert.equal(satisfiesRange("1.0.0", ">=99.0.0"), false);
  assert.equal(satisfiesRange("1.0.0", undefined), true);
});

test("registry resolution honours the CLI override, npm env and ~/.npmrc", () => {
  assert.equal(normalizeRegistryUrl("https://registry.test"), "https://registry.test/");
  assert.equal(resolveNpmRegistry({ TASK_HANDOFF_CLI_REGISTRY: "https://cli.test" }), "https://cli.test/");
  assert.equal(resolveNpmRegistry({ npm_config_registry: "https://npm.test/" }), "https://npm.test/");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "thctl-npmrc-"));
  fs.writeFileSync(path.join(home, ".npmrc"), "registry=https://npmrc.test\n");
  assert.equal(resolveNpmRegistry({}, home), "https://npmrc.test/");
  assert.equal(resolveNpmRegistry({}, home), "https://npmrc.test/");
  assert.equal(resolveNpmRegistry({ TASK_HANDOFF_CLI_REGISTRY: "https://cli.test" }, home), "https://cli.test/");
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(resolveNpmRegistry({}, home), "https://registry.npmjs.org/");
  assert.equal(npmPackageUrl("https://registry.npmjs.org/", "@task-handoff/thctl"), "https://registry.npmjs.org/@task-handoff%2fthctl");
});

test("npm dist-tag lookup degrades to undefined on missing tags and responses", async () => {
  const calls = [];
  const found = await fetchNpmDistTagVersion({
    registry: "https://registry.test/",
    packageName: "@task-handoff/thctl",
    tag: "beta",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ "dist-tags": { latest: "1.0.0", beta: "1.1.0-beta.2" } }), { status: 200 });
    },
  });
  assert.equal(found, "1.1.0-beta.2");
  assert.equal(calls[0], "https://registry.test/@task-handoff%2fthctl");
  const missing = await fetchNpmDistTagVersion({
    registry: "https://registry.test/",
    packageName: "@task-handoff/thctl",
    tag: "alpha",
    fetchImpl: async () => new Response(JSON.stringify({ "dist-tags": { latest: "1.0.0" } }), { status: 200 }),
  });
  assert.equal(missing, undefined);
  const offline = await fetchNpmDistTagVersion({
    registry: "https://registry.test/",
    packageName: "@task-handoff/thctl",
    tag: "latest",
    fetchImpl: async () => new Response("nope", { status: 503 }),
  });
  assert.equal(offline, undefined);
});
