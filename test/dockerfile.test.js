const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Docker runtime uses the supported Node.js 24 release line", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24-bookworm-slim AS build-base$/m);
  assert.match(dockerfile, /^FROM node:24-bookworm-slim AS runtime-base$/m);
});

test("Docker profiles run as agent with passwordless container-root escalation", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /apt-get install -y --no-install-recommends[\s\S]*?\n    sudo \\/);
  assert.match(dockerfile, /printf 'agent ALL=\(root\) NOPASSWD: ALL\\n' > \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.match(dockerfile, /chmod 0440 \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.match(dockerfile, /visudo -cf \/etc\/sudoers\.d\/task-handoff-agent/);
  assert.equal((dockerfile.match(/^USER agent$/gm) || []).length, 4);
});

test("Docker exports Codex, AI, WebCap, and Browser image profiles from shared layers", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.match(dockerfile, /FROM runtime-core AS profile-codex-root/);
  assert.match(dockerfile, /FROM profile-codex-root AS profile-ai-root/);
  assert.match(dockerfile, /FROM profile-ai-root AS profile-gui-root/);
  assert.match(dockerfile, /FROM profile-gui-root AS profile-webcap-root/);
  assert.match(dockerfile, /FROM profile-gui-root AS profile-browser-root/);
  assert.match(dockerfile, /FROM profile-codex-root AS profile-codex[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=codex/);
  assert.match(dockerfile, /FROM profile-ai-root AS profile-ai[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=ai/);
  assert.match(dockerfile, /FROM profile-webcap-root AS profile-webcap[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=webcap/);
  assert.match(dockerfile, /FROM profile-browser-root AS profile-browser[\s\S]*TASK_HANDOFF_IMAGE_PROFILE=browser/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,codex/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,codex,claude/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,gui-terminal,browser,web-cap,codex,claude/);
  assert.match(dockerfile, /io\.task-handoff\.image\.capabilities=terminal,gui-terminal,browser,vscode-web,codex,claude/);
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

test("Docker image bakes a versioned bootstrap runtime while the managed launcher waits for the node-agent artifact", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(dockerfile, /ARG TASK_HANDOFF_VERSION=0\.0\.1[\s\S]*TASK_HANDOFF_VERSION="\$\{TASK_HANDOFF_VERSION\}" pnpm run runtime:pack:controlled-instance/);
  assert.match(dockerfile, /npm install -g --omit=dev[\s\S]*task-handoff-controlled-instance-/);
  assert.match(dockerfile, /FROM runtime-base AS runtime-package-install[\s\S]*apt-get install -y --no-install-recommends g\+\+ make/);
  assert.match(dockerfile, /FROM runtime-base AS runtime-core[\s\S]*COPY --from=runtime-package-install \/usr\/local\/lib\/node_modules\/@task-handoff\/controlled-instance/);
  assert.match(dockerfile, /ln -s \.\.\/lib\/node_modules\/@task-handoff\/controlled-instance\/bin\/task-handoff-controlled-instance \/usr\/local\/bin\/task-handoff-controlled-instance/);
  assert.match(dockerfile, /COPY docker\/instance-launcher\.sh/);
  assert.match(dockerfile, /COPY docker\/runtime-installer\.mjs/);
  const launcher = fs.readFileSync(path.join(root, "docker", "instance-launcher.sh"), "utf8");
  assert.match(launcher, /while \[ ! -L "\$\{current\}" \]/);
  assert.doesNotMatch(launcher, /command -v task-handoff-controlled-instance/);
  assert.doesNotMatch(launcher, /exec task-handoff-controlled-instance web/);
  assert.match(launcher, /await import\(pathToFileURL\(entrypoint\)\.href\)/);
  assert.equal((workflow.match(/task-handoff-controlled-instance web --host 0\.0\.0\.0 --port 8080/g) || []).length, 3);
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
  assert.match(workflow, /target: profile-codex/);
  assert.match(workflow, /target: profile-ai/);
  assert.match(workflow, /target: profile-webcap/);
  assert.match(workflow, /target: profile-browser/);
  assert.match(workflow, /sha_tag="sha-\$\{GITHUB_SHA::7\}-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /"\$\{image\}:\$\{sha_tag\}-amd64"/);
  assert.match(workflow, /"\$\{image\}:\$\{sha_tag\}-arm64"/);
  assert.doesNotMatch(workflow, /branches:\s*\n\s+- main/);
  assert.doesNotMatch(workflow, /refs\/heads\/main/);
  assert.match(workflow, /Publish immutable commit image\n\s+if: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| inputs\.version != '' \}\}/);
  assert.match(workflow, /promote-release:\n\s+if:.*refs\/tags\/v.*\n\s+needs: publish-multiarch-image/);
  assert.match(workflow, /version="v\$\{\{ inputs\.version \}\}"/);
  assert.equal((workflow.match(/docker run -d \\/g) || []).length, 3);
  assert.doesNotMatch(workflow, /docker run --rm -d/);
  assert.doesNotMatch(workflow, /Immutable source image was not published within/);
});

test("Docker tag builds inject the release version while branch builds keep the package version", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /if \[\[ "\$GITHUB_REF" == refs\/tags\/v\* \]\]; then/);
  assert.match(workflow, /version="\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(workflow, /elif \[\[ -n "\$\{\{ inputs\.version \}\}" \]\]; then/);
  assert.match(workflow, /codex_image_ref="\$\{DOCKERHUB_CODEX_IMAGE_NAME\}:\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /ai_image_ref="\$\{DOCKERHUB_AI_IMAGE_NAME\}:\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /webcap_image_ref="\$\{DOCKERHUB_WEBCAP_IMAGE_NAME\}:\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /browser_image_ref="\$\{DOCKERHUB_BROWSER_IMAGE_NAME\}:\$\{GITHUB_REF_NAME\}"/);
  assert.match(workflow, /version="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/);
  assert.match(workflow, /codex_image_ref="task-handoff-controlled-codex:ci-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /ai_image_ref="task-handoff-controlled-ai:ci-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /webcap_image_ref="task-handoff-controlled-webcap:ci-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /browser_image_ref="task-handoff-controlled-browser:ci-\$\{\{ matrix\.arch \}\}"/);
  assert.match(workflow, /TASK_HANDOFF_VERSION=\$\{\{ steps\.image-version\.outputs\.value \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.codex-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.ai-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.webcap-image-ref \}\}/);
  assert.match(workflow, /TASK_HANDOFF_IMAGE_REF=\$\{\{ steps\.image-version\.outputs\.browser-image-ref \}\}/);
  assert.match(workflow, /Verify image version[\s\S]*org\.opencontainers\.image\.version[\s\S]*EXPECTED_VERSION/);
  assert.match(workflow, /status_response="\$\(curl -fsS http:\/\/127\.0\.0\.1:18080\/api\/instance\/status\)"/);
  assert.match(workflow, /diagnostics_response="\$\(curl -fsS http:\/\/127\.0\.0\.1:18080\/api\/diagnostics\)"/);
  assert.match(workflow, /status\.build\.packageVersion !== process\.env\.EXPECTED_VERSION/);
  assert.match(workflow, /status\.build\.imageRef !== process\.env\.EXPECTED_IMAGE_REF/);
  assert.match(workflow, /diagnostics\.runtime\.linuxRuntime/);
  assert.doesNotMatch(workflow, /payload\.build/);
  assert.match(dockerfile, /ARG TASK_HANDOFF_VERSION=0\.0\.1/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim AS runtime-base[\s\S]*ARG TASK_HANDOFF_VERSION=0\.0\.1[\s\S]*ENV TASK_HANDOFF_VERSION=\$\{TASK_HANDOFF_VERSION\}/);
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
