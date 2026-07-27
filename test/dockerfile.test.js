const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Docker runtime uses the supported Node.js 24 release line", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24-bookworm-slim AS base$/m);
});

test("Docker image bakes a versioned bootstrap runtime and retains the managed runtime launcher", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /ARG TASK_HANDOFF_VERSION=0\.0\.1[\s\S]*TASK_HANDOFF_VERSION="\$\{TASK_HANDOFF_VERSION\}" pnpm run runtime:pack:controlled-instance/);
  assert.match(dockerfile, /npm install -g --omit=dev[\s\S]*task-handoff-controlled-instance-/);
  assert.match(dockerfile, /COPY docker\/instance-launcher\.sh/);
  assert.match(dockerfile, /COPY docker\/runtime-installer\.mjs/);
  const launcher = fs.readFileSync(path.join(root, "docker", "instance-launcher.sh"), "utf8");
  assert.match(launcher, /command -v task-handoff-controlled-instance/);
  assert.match(launcher, /exec task-handoff-controlled-instance web/);
  assert.match(launcher, /await import\(pathToFileURL\(entrypoint\)\.href\)/);
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

test("Docker tag builds inject the release version while branch builds keep the package version", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /if \[\[ "\$GITHUB_REF" == refs\/tags\/v\* \]\]; then/);
  assert.match(workflow, /version="\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(workflow, /image_ref="\$\{DOCKERHUB_IMAGE_NAME\}:\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /version="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
  assert.match(workflow, /image_ref="task-handoff-controlled-instance:ci-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /TASK_HANDOFF_VERSION=\$\{\{ steps\.image-version\.outputs\.value \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.image-ref \}\}/);
  assert.match(workflow, /Verify image version[\s\S]*org\.opencontainers\.image\.version[\s\S]*EXPECTED_VERSION/);
  assert.match(workflow, /payload\.build\.packageVersion !== process\.env\.EXPECTED_VERSION/);
  assert.match(workflow, /payload\.build\.imageRef !== process\.env\.EXPECTED_IMAGE_REF/);
  assert.match(dockerfile, /ARG TASK_HANDOFF_VERSION=0\.0\.1/);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.version=\$\{TASK_HANDOFF_VERSION\}/);
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
  const launcher = fs.readFileSync(path.join(root, "docker", "instance-launcher.sh"), "utf8");
  assert.match(entrypoint, /exec task-handoff-instance-launcher/);
  const webCommand = launcher.slice(launcher.indexOf("process.argv ="));
  assert.match(webCommand, /--host/);
  assert.match(webCommand, /--port/);
  assert.doesNotMatch(webCommand, /--socket/);
});
