const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Docker dependency layer includes every workspace manifest", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const dependencyLayer = dockerfile.slice(0, dockerfile.indexOf("RUN pnpm install --frozen-lockfile"));
  const manifests = ["apps", "packages"].flatMap((directory) =>
    fs
      .readdirSync(path.join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${directory}/${entry.name}/package.json`)
      .filter((manifest) => fs.existsSync(path.join(root, manifest))),
  );

  for (const manifest of manifests) {
    assert.ok(
      dependencyLayer.split("\n").includes(`COPY ${manifest} ./${manifest}`),
      `Docker dependency layer must copy ${manifest} before pnpm install`,
    );
  }
});

test("Docker build context includes files read by the test suite", () => {
  const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
  const ignoredEntries = dockerignore
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("#"));

  assert.ok(!ignoredEntries.includes(".github"), ".github workflows are required by release workflow tests");
});

test("Docker fetches the Web Cap skill from its versioned upstream source", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /ARG WEB_CAP_SKILL_REPOSITORY=https:\/\/github\.com\/edgestorage\/web-cap\.git/);
  assert.match(dockerfile, /ARG WEB_CAP_SKILL_REF=v0\.0\.7/);
  assert.match(dockerfile, /sparse-checkout set skills\/web-cap/);
  assert.match(dockerfile, /test -f \/tmp\/task-handoff-web-cap-source\/skills\/web-cap\/SKILL\.md/);
  assert.doesNotMatch(dockerfile, /COPY \.agents\/skills\/web-cap/);
});

test("Docker entrypoint passes only supported web CLI options", () => {
  const entrypoint = fs.readFileSync(path.join(root, "docker", "entrypoint.sh"), "utf8");
  const webCommand = entrypoint.slice(
    entrypoint.indexOf("exec task-handoff-controlled-instance web"),
    entrypoint.indexOf("fi", entrypoint.indexOf("exec task-handoff-controlled-instance web")),
  );
  assert.match(webCommand, /--host/);
  assert.match(webCommand, /--port/);
  assert.doesNotMatch(webCommand, /--socket/);
});
