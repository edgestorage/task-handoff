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

test("Docker CI builds amd64 and arm64 concurrently and publishes a multi-architecture image", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /strategy:\n\s+fail-fast: false\n\s+matrix:/);
  assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(workflow, /arch: amd64\n\s+platform: linux\/amd64\n\s+runner: ubuntu-latest/);
  assert.match(workflow, /arch: arm64\n\s+platform: linux\/arm64\n\s+runner: ubuntu-24\.04-arm/);
  assert.doesNotMatch(workflow, /docker\/setup-qemu-action/);
  assert.match(workflow, /scope=controlled-instance-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /sha_tag="sha-\$\{GITHUB_SHA::7\}-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /"\$\{image\}:\$\{sha_tag\}-amd64"/);
  assert.match(workflow, /"\$\{image\}:\$\{sha_tag\}-arm64"/);
  assert.match(workflow, /Publish immutable commit image\n\s+if: \$\{\{ github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/tags\/v'\) \}\}/);
  assert.match(workflow, /promote-release:\n\s+if:.*refs\/tags\/v.*\n\s+needs: publish-multiarch-image/);
  assert.doesNotMatch(workflow, /Immutable source image was not published within/);
});

test("Docker fetches the Web Cap skill from its versioned upstream source", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /ARG WEB_CAP_SKILL_REPOSITORY=https:\/\/github\.com\/edgestorage\/web-cap\.git/);
  assert.match(dockerfile, /ARG WEB_CAP_SKILL_REF=v0\.0\.7/);
  assert.match(dockerfile, /sparse-checkout set skills\/web-cap/);
  assert.match(dockerfile, /test -f \/tmp\/task-handoff-web-cap-source\/skills\/web-cap\/SKILL\.md/);
  assert.doesNotMatch(dockerfile, /COPY \.agents\/skills\/web-cap/);
});

test("Docker installs Claude Code through the same canonical package managed at runtime", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /npm install -g --include=optional[^\n]*\\\n\s+"@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}"/);
  assert.doesNotMatch(dockerfile, /@anthropic-ai\/claude-code-linux-/);
  assert.doesNotMatch(dockerfile, /claude_native_package/);
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
