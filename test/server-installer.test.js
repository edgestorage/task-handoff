const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("server bootstrap owns the complete Debian and Ubuntu install path", () => {
  const bootstrap = fs.readFileSync(path.join(root, "scripts", "install-server.sh"), "utf8");

  assert.match(bootstrap, /MIN_NODE_VERSION="22\.22\.2"/);
  assert.match(bootstrap, /CHANNEL="stable"/);
  assert.match(bootstrap, /\[ "\$CHANNEL" = "stable" \]/);
  assert.match(bootstrap, /PACKAGE_TARGET="latest"/);
  assert.match(bootstrap, /nodejs\.org\/dist\/latest-v22\.x\/SHASUMS256\.txt/);
  assert.match(bootstrap, /Node\.js archive checksum verification failed/);
  assert.match(bootstrap, /apt-get install -y docker\.io/);
  assert.match(bootstrap, /npm install -g/);
  assert.match(bootstrap, /@task-handoff\/server@\$PACKAGE_TARGET/);
  assert.match(bootstrap, /task-handoff-server-\$VERSION\.tgz/);
  assert.match(bootstrap, /task-handoff install/);
  assert.match(bootstrap, /--artifacts-dir/);
});

test("global server package pins and resolves all three runtime packages", async () => {
  const { runtimePackages } = await import("../runtime-packages.config.mjs");
  const server = runtimePackages.server;
  const wrapper = fs.readFileSync(path.join(root, "scripts", "install-server-package.cjs"), "utf8");

  assert.deepEqual(server.aggregateDependencies, [
    "@task-handoff/control-plane",
    "@task-handoff/node-agent",
    "@task-handoff/controlled-instance",
  ]);
  assert.match(wrapper, /packageBin\("@task-handoff\/control-plane", "task-handoff-control-plane"\)/);
  assert.match(wrapper, /packageBin\("@task-handoff\/node-agent", "task-handoff-node-agent"\)/);
  assert.match(wrapper, /packageBin\("@task-handoff\/controlled-instance", "task-handoff-controlled-instance"\)/);
});

test("server services default to root for host workspace and runtime ownership", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-server-services.sh"), "utf8");
  const remoteInstaller = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "install-scripts.ts"), "utf8");

  assert.match(installer, /SERVICE_USER="root"/);
  assert.match(installer, /systemd service user, default root/);
  assert.match(remoteInstaller, /SERVICE_USER="root"/);
});

test("server services use writable data directories as working directories", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-server-services.sh"), "utf8");

  assert.match(installer, /WorkingDirectory=\$NODE_AGENT_DATA_DIR/);
  assert.match(installer, /WorkingDirectory=\$CONTROL_PLANE_DATA_DIR/);
  assert.doesNotMatch(installer, /WorkingDirectory=\$REPO_DIR/);
});

test("server services use a private IPC socket for local control", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-server-services.sh"), "utf8");
  const readinessCheck = installer.split("ExecStartPre=")[1]?.split("\n", 1)[0] || "";

  assert.match(installer, /TASK_HANDOFF_NODE_AGENT_CONNECTION_MODE=local-ipc/);
  assert.match(installer, /TASK_HANDOFF_NODE_AGENT_CONTROL_ENDPOINT=\$NODE_AGENT_IPC_ENDPOINT/);
  assert.match(installer, /RuntimeDirectory=task-handoff/);
  assert.match(installer, /--connection-mode local-ipc --ipc-path \$NODE_AGENT_IPC_PATH/);
  assert.match(readinessCheck, /\[ -S "\$NODE_AGENT_IPC_PATH" \]/);
  assert.doesNotMatch(readinessCheck, /curl/);
});

test("installer rejects runtime commands inaccessible to the service user", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-server-services.sh"), "utf8");

  assert.match(installer, /runuser -u "\$SERVICE_USER" -- test -x "\$executable"/);
  assert.match(installer, /system-wide prefix such as \/usr\/local/);
});

test("node agent services persist the absolute npm command for managed updates", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-server-services.sh"), "utf8");
  const remoteInstaller = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "install-scripts.ts"), "utf8");
  const worker = fs.readFileSync(path.join(root, "scripts", "node-update-worker.cjs"), "utf8");
  const updater = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "server.ts"), "utf8");

  assert.match(installer, /NPM_COMMAND="\$\(command -v npm\)"/);
  assert.match(installer, /TASK_HANDOFF_NPM_COMMAND=\$NPM_COMMAND/);
  assert.match(remoteInstaller, /NPM_COMMAND="\$\(command -v npm\)"/);
  assert.match(remoteInstaller, /TASK_HANDOFF_NPM_COMMAND=\$NPM_COMMAND/);
  assert.match(worker, /process\.env\.TASK_HANDOFF_NPM_COMMAND \|\| "npm"/);
  assert.match(updater, /process\.env\.TASK_HANDOFF_NPM_COMMAND \|\| "npm"/);
});

test("installed server services use independent runtime commands", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-server-services.sh"), "utf8");

  assert.match(installer, /CONTROL_PLANE_BIN="\$INSTALLER_BIN_DIR\/task-handoff-control-plane"/);
  assert.match(installer, /NODE_AGENT_BIN="\$INSTALLER_BIN_DIR\/task-handoff-node-agent"/);
  assert.match(installer, /CONTROLLED_INSTANCE_BIN="\$INSTALLER_BIN_DIR\/task-handoff-controlled-instance"/);
});

test("server package owns the unified management command and runtimes stay independent", async () => {
  const { runtimePackages } = await import("../runtime-packages.config.mjs");
  const prepare = fs.readFileSync(path.join(root, "scripts", "prepare-runtime-packages.mjs"), "utf8");
  const runtimeCli = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "server.ts"), "utf8");

  assert.equal(runtimePackages.server.binName, "task-handoff");
  assert.equal(runtimePackages["control-plane"].binName, "task-handoff-control-plane");
  assert.equal(runtimePackages["node-agent"].binName, "task-handoff-node-agent");
  assert.equal(runtimePackages["controlled-instance"].binName, "task-handoff-controlled-instance");
  assert.equal(runtimePackages.server.input, "apps/cli/src/runtime/server.ts");
  assert.doesNotMatch(prepare, /task-handoff-server-install/);
  assert.doesNotMatch(prepare, /name === "control-plane"/);
  assert.match(prepare, /task-handoff-install-server-services/);
  assert.match(runtimeCli, /program\.command\("control-plane"[\s\S]*task-handoff-control-plane/);
  assert.match(runtimeCli, /program\.command\("node-agent"[\s\S]*task-handoff-node-agent/);
  assert.match(runtimeCli, /program\.command\("controlled-instance"[\s\S]*task-handoff-controlled-instance/);
  assert.match(runtimeCli, /new Command\(\)/);
});

test("server update CLI preserves configuration and restart ordering", () => {
  const updater = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "server.ts"), "utf8");
  const updateCommand = updater.slice(updater.indexOf('program.command("update")'));
  const nodeRestart = updateCommand.indexOf('"restart", "task-handoff-node-agent.service"');
  const socketReady = updateCommand.indexOf("waitForSocket(nodeSocket)");
  const controlPlaneRestart = updateCommand.indexOf('"restart", "task-handoff-control-plane.service"');

  assert.match(updater, /npmVersion\(target, options\.registry\)/);
  assert.match(updater, /channel === "stable" \? "latest" : channel/);
  assert.match(updater, /\.choices\(\["stable", "beta", "alpha"\]\)/);
  assert.match(updater, /\.conflicts\("to"\)/);
  assert.doesNotMatch(updater, /process\.argv\.includes\("--channel"\)/);
  assert.match(updater, /updateChannelForVersion\(manifest\.version\)/);
  assert.match(updater, /\.default\(defaultUpdateChannel\)/);
  assert.match(updater, /currentInstallOptions\(\)/);
  assert.match(updater, /--control-plane-data-dir/);
  assert.match(updater, /--node-agent-data-dir/);
  assert.match(updater, /task-handoff-server-update\.lock/);
  assert.match(updater, /\["install", \.\.\.preserved\]/);
  assert.ok(nodeRestart < socketReady);
  assert.ok(socketReady < controlPlaneRestart);
});

test("server management CLI supports ordered start, stop, and restart", () => {
  const cli = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "server.ts"), "utf8");
  const stateChange = cli.slice(cli.indexOf("async function changeServerState"), cli.indexOf("function npmTarget"));
  const stopControlPlane = stateChange.indexOf('["stop", "task-handoff-control-plane.service"]');
  const stopNodeAgent = stateChange.indexOf('["stop", "task-handoff-node-agent.service"]');
  const nodeAction = stateChange.indexOf('[action, "task-handoff-node-agent.service"]');
  const socketReady = stateChange.indexOf("waitForSocket(nodeSocket)");
  const controlPlaneAction = stateChange.indexOf('[action, "task-handoff-control-plane.service"]');
  const httpReady = stateChange.indexOf("await waitForHttp(controlPlanePort)");

  assert.match(cli, /program\.command\("start"\)/);
  assert.match(cli, /program\.command\("stop"\)/);
  assert.match(cli, /program\.command\("restart"\)/);
  assert.match(stateChange, /requireRoot\(\)/);
  assert.ok(stopControlPlane < stopNodeAgent);
  assert.ok(nodeAction < socketReady);
  assert.ok(socketReady < controlPlaneAction);
  assert.ok(controlPlaneAction < httpReady);
});

test("server update CLI defaults to the installed release channel", async () => {
  const { isExactSemanticVersion, updateChannelForVersion } = await import("../apps/cli/src/runtime/update-channel.mjs");

  assert.equal(updateChannelForVersion("1.2.3"), "stable");
  assert.equal(updateChannelForVersion("1.2.3-alpha.4"), "alpha");
  assert.equal(updateChannelForVersion("1.2.3-beta.2"), "beta");
  assert.equal(updateChannelForVersion("1.2.3-rc.1"), "stable");
  assert.equal(updateChannelForVersion("1.2.3-alpha.4+build.7"), "alpha");
  assert.equal(isExactSemanticVersion("1.2.3-beta.2+build.7"), true);
  assert.equal(isExactSemanticVersion("v1.2.3"), false);
  assert.equal(isExactSemanticVersion("=1.2.3"), false);
  assert.equal(isExactSemanticVersion("1.2"), false);
  assert.equal(isExactSemanticVersion(" 1.2.3"), false);
  assert.equal(isExactSemanticVersion("1.2.3 "), false);
});

test("node update worker uses Commander for required and validated options", () => {
  const worker = path.join(root, "scripts", "node-update-worker.cjs");
  const help = spawnSync(process.execPath, [worker, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--job-file <path>/);
  assert.match(help.stdout, /--target-version <version>/);

  const invalid = spawnSync(process.execPath, [worker, "--job-file", "/tmp/unused-job.json", "--target-version", "not-semver"], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be an exact semantic version/);
});

test("runtime package scripts use Commander for validated target selection", () => {
  for (const name of ["build-runtime-packages.mjs", "prepare-runtime-packages.mjs", "check-runtime-packages.mjs"]) {
    const source = fs.readFileSync(path.join(root, "scripts", name), "utf8");
    assert.match(source, /from "commander"/);
    assert.match(source, /\.choices\(Object\.keys\(runtimePackages\)\)|\.choices\(targetNames\)/);
    assert.doesNotMatch(source, /process\.argv\.(?:indexOf|includes)/);
  }

  const buildScript = path.join(root, "scripts", "build-runtime-packages.mjs");
  const forwardedHelp = spawnSync(process.execPath, [buildScript, "--", "--help"], { encoding: "utf8" });
  assert.equal(forwardedHelp.status, 0);
  assert.match(forwardedHelp.stdout, /--target <target>/);
});

test("runtime releases map stable to latest and isolate beta and alpha", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "runtime-release.yml"), "utf8");

  assert.match(workflow, /npm_tag="latest"/);
  assert.match(workflow, /"alpha" && "\$npm_tag" != "beta"/);
  assert.match(workflow, /npm publish release\/npm\/server --access public --tag "\$NPM_DIST_TAG"/);
  assert.doesNotMatch(workflow, /npm_tag="stable"/);
  assert.doesNotMatch(workflow, /npm dist-tag add/);
});

test("Docker releases map stable to latest and isolate preview tags", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /tags\+=\(--tag "\$\{image\}:latest"\)/);
  assert.match(workflow, /tags\+=\(--tag "\$\{image\}:\$\{channel\}"\)/);
  assert.doesNotMatch(workflow, /\$\{image\}:stable/);
});
