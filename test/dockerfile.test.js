const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Docker runtime uses the supported Node.js 24 release line", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24-bookworm-slim AS runtime-base$/m);
  assert.doesNotMatch(dockerfile, /^FROM node:24-bookworm-slim AS build-base$/m);
});

test("Docker image build does not install the monorepo or controlled-instance package", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /pnpm install|runtime:pack:controlled-instance/);
  assert.doesNotMatch(dockerfile, /runtime-package-install|@task-handoff\/controlled-instance/);
  assert.doesNotMatch(dockerfile, /task-handoff-controlled-instance/);
  assert.match(dockerfile, /ARG TASK_HANDOFF_IMAGE_VERSION=0\.0\.1/);
  assert.match(dockerfile, /ENV TASK_HANDOFF_IMAGE_VERSION=\$\{TASK_HANDOFF_IMAGE_VERSION\}/);
});

test("Docker profiles run as agent with passwordless container-root escalation", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /apt-get install -y --no-install-recommends[\s\S]*?\n    sudo \\/);
  assert.match(dockerfile, /printf 'agent ALL=\(root\) NOPASSWD: ALL\\n' > \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.match(dockerfile, /chmod 0440 \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.match(dockerfile, /visudo -cf \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.equal((dockerfile.match(/^USER agent$/gm) || []).length, 5);
});

test("Docker exports Codex, OpenCode, AI, WebCap, and Browser image profiles from shared layers", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const buildScript = fs.readFileSync(path.join(root, "scripts", "docker-build-image.sh"), "utf8");

  assert.match(dockerfile, /FROM runtime-core AS profile-codex-root/);
  assert.match(dockerfile, /FROM runtime-core AS profile-opencode-root/);
  assert.match(dockerfile, /FROM profile-codex-root AS profile-ai-root/);
  assert.match(dockerfile, /FROM profile-ai-root AS profile-gui-root/);
  assert.match(dockerfile, /FROM profile-gui-root AS profile-webcap-root/);
  assert.match(dockerfile, /FROM profile-gui-root AS profile-browser-root/);
  assert.match(dockerfile, /FROM profile-codex-root AS profile-codex[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=codex/);
  assert.match(dockerfile, /FROM profile-opencode-root AS profile-opencode[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=opencode/);
  assert.match(dockerfile, /FROM profile-ai-root AS profile-ai[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=ai/);
  assert.match(dockerfile, /FROM profile-webcap-root AS profile-webcap[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=webcap/);
  assert.match(dockerfile, /FROM profile-browser-root AS profile-browser[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=browser/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,codex/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,opencode/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,codex,claude/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,gui-terminal,browser,web-cap,codex,claude/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,gui-terminal,browser,vscode-web,codex,claude/);
  assert.match(dockerfile, /ARG OPENCODE_CLI_PACKAGE=opencode-ai@latest[\s\S]*npm install -g[\s\S]*"\$OPENCODE_CLI_PACKAGE"[\s\S]*opencode --version/);
  assert.match(buildScript, /opencode\)\n\s+BUILD_TARGET="profile-opencode"\n\s+DEFAULT_IMAGE_REF="task-handoff-controlled-opencode:local"/);
  assert.match(buildScript, /OPENCODE_CLI_PACKAGE=\$\{OPENCODE_CLI_PACKAGE:-opencode-ai@latest\}/);
});

test("Docker WebCap profile installs WebCap without code-server", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const webcapRootStart = dockerfile.indexOf("FROM profile-gui-root AS profile-webcap-root");
  const browserRootStart = dockerfile.indexOf("FROM profile-gui-root AS profile-browser-root");
  const exportedProfilesStart = dockerfile.indexOf("# Each exported target");
  const webcapRoot = dockerfile.slice(webcapRootStart, browserRootStart);
  const browserRoot = dockerfile.slice(browserRootStart, exportedProfilesStart);

  assert.ok(webcapRootStart >= 0 && browserRootStart > webcapRootStart);
  assert.match(webcapRoot, /install_web_cap/);
  assert.doesNotMatch(dockerfile, /TASK_HANDOFF_ENABLE_WEB_CAP/);
  assert.doesNotMatch(webcapRoot, /code-server/);
  assert.match(browserRoot, /code-server_\$\{CODE_SERVER_VERSION\}/);
});

test("Docker image contains only the managed launcher and waits for the node-agent artifact", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(dockerfile, /FROM runtime-base AS runtime-core/);
  assert.doesNotMatch(dockerfile, /runtime-package-install|@task-handoff\/controlled-instance|task-handoff-controlled-instance/);
  assert.match(dockerfile, /COPY docker\/instance-launcher\.sh/);
  assert.match(dockerfile, /COPY docker\/runtime-installer\.mjs/);
  const launcher = fs.readFileSync(path.join(root, "docker", "instance-launcher.sh"), "utf8");
  assert.match(launcher, /while \[ ! -L "\$\{current\}" \]/);
  assert.doesNotMatch(launcher, /command -v task-handoff-controlled-instance/);
  assert.doesNotMatch(launcher, /exec task-handoff-controlled-instance web/);
  assert.match(launcher, /await import\(pathToFileURL\(entrypoint\)\.href\)/);
  assert.doesNotMatch(workflow, /task-handoff-controlled-instance web --host 0\.0\.0\.0 --port 8080/);
  assert.match(workflow, /Smoke test profile environments without embedded runtime/);
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
  assert.match(workflow, /scope=docker-image-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /target: profile-codex/);
  assert.match(workflow, /target: profile-opencode/);
  assert.match(workflow, /target: profile-ai/);
  assert.match(workflow, /target: profile-webcap/);
  assert.match(workflow, /target: profile-browser/);
  assert.match(workflow, /sha_tag="docker-sha-\$\{GITHUB_SHA::7\}-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /"\$\{image\}:\$\{sha_tag\}-amd64"/);
  assert.match(workflow, /"\$\{image\}:\$\{sha_tag\}-arm64"/);
  assert.doesNotMatch(workflow, /branches:\s*\n\s+- main/);
  assert.doesNotMatch(workflow, /refs\/heads\/main/);
  assert.match(workflow, /Publish immutable commit image\n\s+if: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/docker-v'\) \|\| inputs\.image_version != '' \}\}/);
  assert.match(workflow, /promote-release:\n\s+if:.*refs\/tags\/docker-v.*\n\s+needs: publish-multiarch-image/);
  assert.match(workflow, /REQUESTED_IMAGE_VERSION: \$\{\{ inputs\.image_version \}\}/);
  assert.match(workflow, /version="docker-v\$\{REQUESTED_IMAGE_VERSION\}"/);
  assert.match(workflow, /release_version="\$\{version#docker-v\}"/);
  assert.match(workflow, /if \[\[ "\$release_version" != \*-\* \]\]; then/);
  assert.match(workflow, /docker run -d --name/);
  assert.doesNotMatch(workflow, /docker run --rm -d/);
  assert.doesNotMatch(workflow, /Immutable source image was not published within/);
});

test("Docker tag builds inject an independent Docker release version", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /if \[\[ "\$GITHUB_REF" == refs\/tags\/docker-v\* \]\]; then/);
  assert.match(workflow, /version="\$\{GITHUB_REF_NAME#docker-v\}"/);
  assert.match(workflow, /REQUESTED_IMAGE_VERSION: \$\{\{ inputs\.image_version \}\}/);
  assert.match(workflow, /elif \[\[ -n "\$\{REQUESTED_IMAGE_VERSION\}" \]\]; then/);
  assert.match(workflow, /codex-image-ref=\$\{DOCKERHUB_CODEX_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /opencode-image-ref=\$\{DOCKERHUB_OPENCODE_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /ai-image-ref=\$\{DOCKERHUB_AI_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /webcap-image-ref=\$\{DOCKERHUB_WEBCAP_IMAGE_NAME\}:\$\{tag\}/);
  assert.match(workflow, /browser-image-ref=\$\{DOCKERHUB_BROWSER_IMAGE_NAME\}:\$\{tag\}/);
  assert.doesNotMatch(workflow, /require\('\.\/package\.json'\)\.version/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_VERSION=\$\{\{ steps\.image-version\.outputs\.value \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.codex-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.opencode-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.ai-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.webcap-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.browser-image-ref \}\}/);
  assert.match(workflow, /Verify image metadata[\s\S]*org\.opencontainers\.image\.version[\s\S]*EXPECTED_VERSION/);
  assert.match(workflow, /controlled-instance absence/);
  assert.match(workflow, /test ! -e \/usr\/local\/bin\/task-handoff-controlled-instance/);
  assert.match(dockerfile, /ARG TASK_HANDOFF_IMAGE_VERSION=0\.0\.1/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS runtime-base[\s\S]*ARG TASK_HANDOFF_IMAGE_VERSION=0\.0\.1[\s\S]*ENV TASK_HANDOFF_IMAGE_VERSION=\$\{TASK_HANDOFF_IMAGE_VERSION\}/);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.version=\$\{TASK_HANDOFF_IMAGE_VERSION\}/);
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
