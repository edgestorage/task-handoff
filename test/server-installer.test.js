const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { currentServerInstallArgs } = require("../packages/core/src/core/server-update-installation.ts");

const root = path.resolve(__dirname, "..");

test("server update installation arguments preserve the authoritative service configuration", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-install-args-"));
  const controlPlaneEnvFile = path.join(directory, "control-plane.env");
  const nodeAgentEnvFile = path.join(directory, "node-agent.env");
  const nodeAgentUnitFile = path.join(directory, "node-agent.service");
  fs.writeFileSync(controlPlaneEnvFile, [
    "TASK_HANDOFF_CONTROL_PLANE_DATA_DIR=/srv/control-plane",
    "TASK_HANDOFF_CONTROL_PLANE_HOST=10.0.0.4",
    "TASK_HANDOFF_CONTROL_PLANE_PORT=9443",
    "TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE=disabled",
    "TASK_HANDOFF_CONTROL_PLANE_STATIC_DIR=/srv/task-handoff/ui",
  ].join("\n"));
  fs.writeFileSync(nodeAgentEnvFile, [
    "TASK_HANDOFF_NODE_AGENT_DATA_DIR=/srv/node-agent",
    "TASK_HANDOFF_NODE_AGENT_HOST=10.0.0.5",
    "TASK_HANDOFF_NODE_AGENT_PORT=9555",
    "TASK_HANDOFF_NODE_AGENT_IPC_PATH=/srv/run/node-agent.sock",
  ].join("\n"));
  fs.writeFileSync(nodeAgentUnitFile, "[Service]\nUser=task-handoff\n");

  assert.deepEqual(currentServerInstallArgs({ controlPlaneEnvFile, nodeAgentEnvFile, nodeAgentUnitFile }), [
    "--service-user", "task-handoff",
    "--control-plane-data-dir", "/srv/control-plane",
    "--node-agent-data-dir", "/srv/node-agent",
    "--control-plane-host", "10.0.0.4",
    "--control-plane-port", "9443",
    "--node-agent-host", "10.0.0.5",
    "--node-agent-port", "9555",
    "--node-agent-ipc-path", "/srv/run/node-agent.sock",
    "--auth-mode", "disabled",
    "--static-dir", "/srv/task-handoff/ui",
  ]);
  fs.rmSync(directory, { recursive: true, force: true });
});

function typescriptSources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptSources(filename);
    return entry.isFile() && entry.name.endsWith(".ts")
      ? [{ filename, source: fs.readFileSync(filename, "utf8") }]
      : [];
  });
}

test("server bootstrap owns Debian, Ubuntu, RHEL, and CentOS install paths without target-host native builds", () => {
  const bootstrap = fs.readFileSync(path.join(root, "scripts", "install-server.sh"), "utf8");

  assert.match(bootstrap, /MIN_NODE_VERSION="24\.15\.0"/);
  assert.match(bootstrap, /CHANNEL="stable"/);
  assert.match(bootstrap, /\[ "\$CHANNEL" = "stable" \]/);
  assert.match(bootstrap, /PACKAGE_TARGET="latest"/);
  assert.match(bootstrap, /nodejs\.org\/dist\/latest-v24\.x\/SHASUMS256\.txt/);
  assert.match(bootstrap, /Node\.js archive checksum verification failed/);
  assert.doesNotMatch(bootstrap, /g\+\+|gcc-c\+\+|make python3/);
  assert.match(bootstrap, /apt-get install -y docker\.io/);
  assert.match(bootstrap, /dnf install -y ca-certificates curl tar xz/);
  assert.match(bootstrap, /download\.docker\.com\/linux\/\$docker_repo_os\/docker-ce\.repo/);
  assert.match(bootstrap, /dnf install -y docker-ce docker-ce-cli containerd\.io/);
  assert.doesNotMatch(bootstrap, /dpkg --compare-versions/);
  assert.match(bootstrap, /npm install -g/);
  assert.match(bootstrap, /@task-handoff\/server@\$PACKAGE_TARGET/);
  assert.match(bootstrap, /task-handoff-server-\$VERSION\.tgz/);
  assert.match(bootstrap, /task-handoff install/);
  assert.match(bootstrap, /--artifacts-dir/);
});

test("remote node-agent bootstrap installs Node.js portably without a native build environment", () => {
  const installer = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "control-plane", "nodes", "install-script.ts"), "utf8");

  assert.match(installer, /MIN_NODE_VERSION="24\.15\.0"/);
  assert.match(installer, /ensure_node_environment/);
  assert.match(installer, /if node_is_compatible && command -v npm/);
  assert.match(installer, /apt-get install -y ca-certificates curl xz-utils/);
  assert.match(installer, /dnf install -y ca-certificates curl tar xz/);
  assert.match(installer, /nodejs\.org\/dist\/latest-v24\.x\/SHASUMS256\.txt/);
  assert.match(installer, /Node\.js archive checksum verification failed/);
  assert.doesNotMatch(installer, /g\+\+|gcc-c\+\+|make python3/);
  assert.doesNotMatch(installer, /dpkg --compare-versions/);
  assert.match(installer, /case "\$current_node_version" in[\s\S]*24\.\*/);
});

test("remote node-agent bootstrap accepts a compatible preinstalled Node without a distro package manager", async () => {
  const { nodeAgentInstallScript } = await import("../packages/control-plane/src/control-plane/nodes/install-script.ts");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-installer-"));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const npmPath = spawnSync("/usr/bin/which", ["npm"], { encoding: "utf8" }).stdout.trim();
  assert.ok(npmPath);
  fs.symlinkSync(npmPath, path.join(bin, "npm"));
  const commands = {
    id: "#!/bin/sh\necho 0\n",
    systemctl: "#!/bin/sh\nexit 0\n",
    uname: "#!/bin/sh\n[ \"$1\" = \"-s\" ] && echo Linux || echo x86_64\n",
    getconf: "#!/bin/sh\necho 'glibc 2.28'\n",
  };
  for (const [command, contents] of Object.entries(commands)) {
    fs.writeFileSync(path.join(bin, command), contents, { mode: 0o755 });
  }
  const installer = nodeAgentInstallScript().replace("\nensure_node_environment\n", "\nensure_node_environment\nexit 0\n");
  const result = spawnSync("/bin/sh", ["-s", "--", "--control-plane", "https://control.example.com"], {
    input: installer,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Using existing Node\.js/);
    assert.doesNotMatch(result.stdout, /package metadata|prerequisites with dnf/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote node-agent bootstrap restarts and verifies the installed service through IPC", () => {
  const installer = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "control-plane", "nodes", "install-script.ts"), "utf8");
  const enable = installer.indexOf("systemctl enable task-handoff-node-agent.service");
  const restart = installer.indexOf("systemctl restart task-handoff-node-agent.service");
  const readiness = installer.indexOf('curl --unix-socket "$IPC_PATH" -fsS "http://localhost/api/node-agent/health"');
  const pairing = installer.indexOf('"http://localhost/api/node-agent/control-plane-connections"');

  assert.ok(enable >= 0);
  assert.ok(restart > enable);
  assert.ok(readiness > restart);
  assert.ok(pairing > readiness);
  assert.doesNotMatch(installer, /systemctl enable --now task-handoff-node-agent\.service/);
  assert.match(installer, /Compatibility for v0\.0\.24:/);
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
  const remoteInstaller = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "control-plane", "nodes", "install-script.ts"), "utf8");

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

test("password-auth installation initializes random administrator credentials before service exposure", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-server-services.sh"), "utf8");
  const initialize = installer.indexOf("credentials --initialize-if-needed");
  const startControlPlane = installer.indexOf("systemctl enable --now task-handoff-control-plane.service");

  assert.match(installer, /randomBytes\(6\)/);
  assert.match(installer, /randomBytes\(24\)/);
  assert.match(installer, /printf '%s\\n' "\$ADMIN_PASSWORD" \|/);
  assert.doesNotMatch(installer, /TASK_HANDOFF_CONTROL_PLANE_(?:ADMIN_)?PASSWORD=/);
  assert.doesNotMatch(installer, /has_control_plane_admin/);
  assert.match(installer, /if \[ "\$AUTH_MODE" = "password" \]; then/);
  assert.ok(initialize >= 0);
  assert.ok(initialize < startControlPlane);
  assert.match(installer, /Compatibility for v0\.0\.21:/);
  assert.match(installer, /credentials \(shown once\)/);
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
  const remoteInstaller = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "control-plane", "nodes", "install-script.ts"), "utf8");
  const worker = fs.readFileSync(path.join(root, "scripts", "node-update-worker.cts"), "utf8");
  const updater = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "server.ts"), "utf8");

  assert.match(installer, /NPM_COMMAND="\$\(command -v npm\)"/);
  assert.match(installer, /TASK_HANDOFF_NPM_COMMAND=\$NPM_COMMAND/);
  assert.match(installer, /TASK_HANDOFF_CONTROL_PLANE_HEALTH_URL=http:\/\/127\.0\.0\.1:\$CONTROL_PLANE_PORT\/api\/health/);
  assert.match(remoteInstaller, /NPM_COMMAND="\$\(command -v npm\)"/);
  assert.match(remoteInstaller, /TASK_HANDOFF_NPM_COMMAND=\$NPM_COMMAND/);
  assert.match(worker, /process\.env\.TASK_HANDOFF_NPM_COMMAND \|\| "npm"/);
  assert.match(updater, /process\.env\.TASK_HANDOFF_NPM_COMMAND \|\| "npm"/);
});

test("node agent updates discover the package that owns their launcher", () => {
  const installer = fs.readFileSync(path.join(root, "scripts", "install-server-services.sh"), "utf8");
  const remoteInstaller = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "control-plane", "nodes", "install-script.ts"), "utf8");
  const updater = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "node-agent", "updates.ts"), "utf8");

  assert.doesNotMatch(installer, /TASK_HANDOFF_NODE_UPDATE_PACKAGE/);
  assert.doesNotMatch(remoteInstaller, /TASK_HANDOFF_NODE_UPDATE_PACKAGE/);
  assert.match(updater, /installedPackageManifest\(globalRoot, "@task-handoff\/server"\)/);
  assert.match(updater, /relatedCurrentVersions/);
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
  assert.deepEqual(runtimePackages["control-plane"].bundledDependencies, ["@fastify/compress"]);
  assert.equal(runtimePackages["control-plane"].dependencies["@fastify/compress"], undefined);
  assert.equal(runtimePackages["control-plane"].dependencies["drizzle-orm"], "1.0.0-rc.4");
  assert.equal(runtimePackages["control-plane"].dependencies.pg, "8.16.3");
  assert.equal(runtimePackages["node-agent"].binName, "task-handoff-node-agent");
  assert.deepEqual(runtimePackages["node-agent"].bundledDependencies, ["@fastify/compress"]);
  assert.equal(runtimePackages["node-agent"].dependencies["@fastify/compress"], undefined);
  assert.equal(runtimePackages["node-agent"].dependencies["drizzle-orm"], undefined);
  assert.equal(runtimePackages["node-agent"].dependencies.pg, undefined);
  assert.equal(runtimePackages["controlled-instance"].binName, "task-handoff-controlled-instance");
  assert.deepEqual(runtimePackages["controlled-instance"].dependencies, { "node-pty": "^1.1.0" });
  for (const name of ["control-plane", "node-agent", "controlled-instance"]) {
    assert.deepEqual(runtimePackages[name].bundledNativeDependencies, ["node-pty"]);
  }
  assert.equal(runtimePackages.server.input, "apps/cli/src/runtime/server.ts");
  assert.doesNotMatch(prepare, /task-handoff-server-install/);
  assert.doesNotMatch(prepare, /name === "control-plane"/);
  assert.match(prepare, /task-handoff-install-server-services/);
  assert.match(runtimeCli, /program\.command\("control-plane"[\s\S]*task-handoff-control-plane/);
  assert.match(runtimeCli, /program\.command\("node-agent"[\s\S]*task-handoff-node-agent/);
  assert.match(runtimeCli, /program\.command\("controlled-instance"[\s\S]*task-handoff-controlled-instance/);
  assert.match(runtimeCli, /new Command\(\)/);
});

test("runtime package archives verify every directly executed helper", () => {
  const builder = fs.readFileSync(path.join(root, "scripts", "build-runtime-packages.mjs"), "utf8");
  for (const executable of [
    "bin/task-handoff-install-server",
    "bin/task-handoff-install-server-services",
    "bin/task-handoff-node-update-worker",
    "docker/entrypoint.sh",
    "docker/instance-launcher.sh",
    "docker/runtime-installer.mjs",
  ]) {
    assert.ok(builder.includes(executable), `missing archive executable assertion for ${executable}`);
  }
  assert.match(builder, /\(entry\.mode & 0o111\) === 0/);
  assert.match(builder, /verifyArchiveExecutables/);
});

test("runtime package builds transform and execute CommonJS TypeScript workers", () => {
  const rollup = fs.readFileSync(path.join(root, "rollup.config.mjs"), "utf8");
  const checker = fs.readFileSync(path.join(root, "scripts", "check-runtime-packages.mjs"), "utf8");

  assert.match(rollup, /extensions: \["\.cjs", "\.cts", "\.js", "\.ts"\]/);
  assert.match(rollup, /id\.startsWith\("node:"\)/);
  assert.match(checker, /runtime output references repository source/);
  assert.match(checker, /update worker smoke test failed/);
  assert.match(checker, /workerPath, "--help"/);
  assert.match(checker, /assertNoControlPlaneDatabasePayload/);
  assert.match(checker, /checkEmbeddedControlledInstance/);
});

test("standalone node-agent CLI can create pairing invites over local IPC", () => {
  const runtimeCli = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "node-agent.ts"), "utf8");
  const remoteInstaller = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "control-plane", "nodes", "install-script.ts"), "utf8");

  assert.match(runtimeCli, /\.command\("invite"\)/);
  assert.match(runtimeCli, /fetchNodeAgentIpc/);
  assert.match(runtimeCli, /options\.endpoint\s*\? undefined\s*:\s*explicitIpcPath \|\| nodeAgentIpcPath/);
  assert.match(runtimeCli, /Join token:/);
  assert.match(runtimeCli, /\.option\("--json"/);
  assert.match(remoteInstaller, /TASK_HANDOFF_NODE_AGENT_CONNECTION_MODE=local-ipc/);
  assert.match(remoteInstaller, /TASK_HANDOFF_NODE_AGENT_IPC_PATH=\$IPC_PATH/);
  assert.match(remoteInstaller, /invite --ipc-path \$IPC_PATH/);
});

test("standalone node-agent CLI can connect an existing service to a control plane over local IPC", () => {
  const runtimeCli = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "node-agent.ts"), "utf8");
  assert.match(runtimeCli, /\.command\("connect"\)/);
  assert.match(runtimeCli, /\.requiredOption\("--control-plane <url>"/);
  assert.match(runtimeCli, /\.requiredOption\("--join-token <token>"/);
  assert.match(runtimeCli, /fetchNodeAgentIpc\(options\.ipcPath!, "\/control-plane-connections"/);
  assert.match(runtimeCli, /activate: true/);
});

test("standalone node-agent CLI can uninstall while preserving data by default", () => {
  const runtimeCli = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "node-agent.ts"), "utf8");
  const uninstaller = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "node-agent", "uninstall.ts"), "utf8");
  assert.match(runtimeCli, /\.command\("uninstall"\)/);
  assert.match(runtimeCli, /\.option\("--delete-data"/);
  assert.match(runtimeCli, /\.option\("--keep-data"/);
  assert.match(uninstaller, /\["disable", "--now", NODE_AGENT_SERVICE\]/);
  assert.match(uninstaller, /await dependencies\.confirmDeleteData\(dataDir\)/);
  assert.match(uninstaller, /Docker volumes are preserved\. \[y\/N\]/);
});

test("node-agent installer honors an explicit npm package before an ambient binary", () => {
  const installer = fs.readFileSync(path.join(root, "packages", "control-plane", "src", "control-plane", "nodes", "install-script.ts"), "utf8");
  const explicitPackage = installer.indexOf('elif [ -n "$NPM_PACKAGE" ]; then');
  const ambientBinary = installer.indexOf("elif command -v task-handoff-node-agent");

  assert.ok(explicitPackage >= 0);
  assert.ok(ambientBinary > explicitPackage);
});

test("server update CLI delegates configuration, installation, rollback, and restart ordering to the shared worker", () => {
  const updater = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "server.ts"), "utf8");
  const updateLock = fs.readFileSync(path.join(root, "apps", "cli", "src", "runtime", "update-lock.mjs"), "utf8");
  const installation = fs.readFileSync(path.join(root, "packages", "core", "src", "core", "server-update-installation.ts"), "utf8");
  const worker = fs.readFileSync(path.join(root, "scripts", "node-update-worker.cts"), "utf8");
  const updateCommand = updater.slice(updater.indexOf('program.command("update")'));
  const materialize = worker.indexOf("materializeServerServices(prefix)");
  const controlPlaneRestart = worker.indexOf('run("systemctl", ["restart", "task-handoff-control-plane.service"])', materialize);
  const healthReady = worker.indexOf("await waitForControlPlaneHealth(controlPlaneHealthUrl)", controlPlaneRestart);
  const nodeRestart = worker.indexOf('run("systemctl", ["restart", service])', healthReady);

  assert.match(updater, /npmVersion\(target, options\.registry\)/);
  assert.match(updater, /channel === "stable" \? "latest" : channel/);
  assert.match(updater, /\.choices\(\["stable", "beta", "alpha"\]\)/);
  assert.match(updater, /\.conflicts\("to"\)/);
  assert.doesNotMatch(updater, /process\.argv\.includes\("--channel"\)/);
  assert.match(updater, /updateChannelForVersion\(manifest\.version\)/);
  assert.match(updater, /\.default\(defaultUpdateChannel\)/);
  assert.match(updater, /currentInstallOptions\(\)/);
  assert.match(updateLock, /acquireServerUpdateLock/);
  assert.match(installation, /task-handoff-server-update\.lock/);
  assert.match(updateCommand, /task-handoff-node-update-worker/);
  assert.match(updateCommand, /--install-prefix/);
  assert.match(worker, /--preserve-current/);
  assert.match(worker, /rollback = async/);
  assert.ok(materialize < controlPlaneRestart);
  assert.ok(controlPlaneRestart < healthReady);
  assert.ok(healthReady < nodeRestart);
});

test("runtime package versions use one resolver for explicit, bundled, and workspace builds", async () => {
  const { controlledInstancePackageVersionResolver, executablePackageVersionResolver, packageVersionResolver, resolvePackageVersion } = await import("../packages/core/src/core/package-version.ts");
  const sourceRoot = path.join(root, "packages", "control-plane", "src");
  const nodeAgentRoot = path.join(sourceRoot, "node-agent");
  const facadeFilename = path.join(sourceRoot, "node-agent.ts");
  const nodeAgentSources = [
    { filename: facadeFilename, source: fs.readFileSync(facadeFilename, "utf8") },
    ...typescriptSources(nodeAgentRoot),
  ];
  const resolverSources = nodeAgentSources.filter(({ source }) => /\bpackageVersionResolver\b/.test(source));
  assert.deepEqual(resolverSources.map(({ filename }) => path.relative(sourceRoot, filename)), [path.join("node-agent", "runtime-version-state.ts")]);
  const runtimeVersionState = resolverSources[0].source;
  assert.equal(runtimeVersionState.match(/\bpackageVersionResolver\s*\(/g)?.length, 1);
  assert.match(runtimeVersionState, /packageVersionResolver\([\s\S]*?"@task-handoff\/node-agent"[\s\S]*?"@task-handoff\/control-plane"[\s\S]*?\);/);
  const appSource = nodeAgentSources.find(({ filename }) => path.relative(sourceRoot, filename) === path.join("node-agent", "app.ts"))?.source || "";
  assert.match(appSource, /import\s*\{[^}]*\bdesiredControlledInstanceVersion\b[^}]*\}\s*from\s*"\.\/runtime-version-state\.ts"/);
  assert.match(appSource, /desiredControlledInstanceVersion\(\)/);
  assert.equal(resolvePackageVersion("@task-handoff/cli", { TASK_HANDOFF_VERSION: " 9.8.7 " }), "9.8.7");
  assert.equal(resolvePackageVersion("@task-handoff/cli", {}), "0.0.1");
  assert.equal(resolvePackageVersion("@task-handoff/controlled-instance", {}), "1.0.0");
  assert.equal(resolvePackageVersion("@task-handoff/node-agent", {}, "@task-handoff/control-plane"), "1.0.0");
  const resolverEnv = {};
  const cachedResolver = packageVersionResolver("@task-handoff/cli", resolverEnv);
  assert.equal(cachedResolver(), "0.0.1");
  resolverEnv.TASK_HANDOFF_VERSION = " 9.8.7 ";
  assert.equal(cachedResolver(), "9.8.7");
  delete resolverEnv.TASK_HANDOFF_VERSION;
  assert.equal(cachedResolver(), "0.0.1");

  const packagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-package-version-"));
  const packagedBin = path.join(packagedRoot, "bin", "task-handoff-control-plane");
  fs.mkdirSync(path.dirname(packagedBin), { recursive: true });
  fs.writeFileSync(path.join(packagedRoot, "package.json"), JSON.stringify({
    name: "@task-handoff/control-plane",
    version: "2.3.4-alpha.1",
  }));
  fs.writeFileSync(packagedBin, "#!/usr/bin/env node\n");
  const linkedBin = path.join(packagedRoot, "global-bin", "task-handoff-controlled-instance");
  const controlledPackageRoot = path.join(packagedRoot, "global-packages", "controlled-instance");
  const controlledPackageBin = path.join(controlledPackageRoot, "bin", "task-handoff-controlled-instance");
  fs.mkdirSync(path.dirname(controlledPackageBin), { recursive: true });
  fs.mkdirSync(path.dirname(linkedBin), { recursive: true });
  fs.writeFileSync(path.join(controlledPackageRoot, "package.json"), JSON.stringify({
    name: "@task-handoff/controlled-instance",
    version: "3.4.5",
  }));
  fs.writeFileSync(controlledPackageBin, "#!/usr/bin/env node\n");
  fs.symlinkSync(controlledPackageBin, linkedBin);
  const previousEntry = process.argv[1];
  try {
    process.argv[1] = packagedBin;
    assert.equal(resolvePackageVersion("@task-handoff/control-plane", {}), "2.3.4-alpha.1");
    assert.equal(executablePackageVersionResolver("@task-handoff/control-plane", { TASK_HANDOFF_VERSION: "1.0.0" })(), "2.3.4-alpha.1");
    assert.equal(controlledInstancePackageVersionResolver({
      TASK_HANDOFF_VERSION: "1.0.0",
      TASK_HANDOFF_CONTROLLED_INSTANCE_VERSION: " 2.3.4-alpha.1 ",
    })(), "2.3.4-alpha.1");
    process.argv[1] = linkedBin;
    assert.equal(
      controlledInstancePackageVersionResolver({ TASK_HANDOFF_VERSION: "1.0.0" })(),
      "3.4.5",
      "the executable package behind a global-bin symlink is authoritative over the base image version",
    );
  } finally {
    process.argv[1] = previousEntry;
    fs.rmSync(packagedRoot, { recursive: true, force: true });
  }
});

test("server update lock rejects a live owner and recovers after it exits", async () => {
  const { acquireUpdateLock } = await import("../apps/cli/src/runtime/update-lock.mjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-update-lock-"));
  const lockPath = path.join(temp, "update.lock");
  const release = acquireUpdateLock(lockPath);

  assert.throws(() => acquireUpdateLock(lockPath), /already running/);
  release();

  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 2147483647, startTime: "missing" }));
  const releaseRecovered = acquireUpdateLock(lockPath);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).pid, process.pid);
  releaseRecovered();

  fs.mkdirSync(lockPath);
  fs.utimesSync(lockPath, new Date(0), new Date(0));
  const releaseLegacy = acquireUpdateLock(lockPath);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).pid, process.pid);
  releaseLegacy();
  fs.rmSync(temp, { recursive: true, force: true });
});

test("server update lock does not steal a slow live initializer", async () => {
  const { acquireUpdateLock } = await import("../apps/cli/src/runtime/update-lock.mjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-update-initializing-"));
  const lockPath = path.join(temp, "update.lock");
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, "initializing.json"), JSON.stringify({
    token: "still-initializing",
    pid: process.pid,
    startedAt: new Date(0).toISOString(),
  }));
  assert.throws(() => acquireUpdateLock(lockPath, { legacyGraceMs: 0 }), /already running/);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("concurrent server updaters have exactly one lock owner", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-update-race-"));
  const lockPath = path.join(temp, "update.lock");
  const modulePath = path.join(root, "apps", "cli", "src", "runtime", "update-lock.mjs");
  const script = [
    `import { acquireUpdateLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
    "process.stdin.once('data', () => {",
    `  try { const release = acquireUpdateLock(${JSON.stringify(lockPath)}); console.log('acquired'); process.stdin.once('data', () => { release(); process.exit(0); }); }`,
    "  catch { console.log('rejected'); process.exit(0); }",
    "});",
  ].join("\n");
  const children = [0, 1].map(() => spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["pipe", "pipe", "inherit"],
  }));
  const outcomes = children.map((child) => once(child.stdout, "data").then(([chunk]) => String(chunk).trim()));
  for (const child of children) child.stdin.write("go\n");
  const result = await Promise.all(outcomes);
  assert.deepEqual([...result].sort(), ["acquired", "rejected"]);
  const owner = result.indexOf("acquired");
  children[owner].stdin.write("release\n");
  await Promise.all(children.map((child) => child.exitCode === null ? once(child, "exit") : undefined));
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("server update lock cleans up when interrupted", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-update-signal-"));
  const lockPath = path.join(temp, "update.lock");
  const modulePath = path.join(root, "apps", "cli", "src", "runtime", "update-lock.mjs");
  const script = [
    `import { acquireUpdateLock, cleanUpLockOnSignals } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
    `const release = acquireUpdateLock(${JSON.stringify(lockPath)});`,
    "cleanUpLockOnSignals(release);",
    "console.log('ready');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "inherit"] });
  await once(child.stdout, "data");
  child.kill("SIGINT");
  const [code, signal] = await once(child, "exit");

  assert.equal(code, null);
  assert.equal(signal, "SIGINT");
  assert.equal(fs.existsSync(lockPath), false);
  fs.rmSync(temp, { recursive: true, force: true });
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
  const worker = path.join(root, "scripts", "node-update-worker.cts");
  const source = fs.readFileSync(worker, "utf8");
  const help = spawnSync(process.execPath, [worker, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--job-file <path>/);
  assert.match(help.stdout, /--target-version <version>/);

  const invalid = spawnSync(process.execPath, [worker, "--job-file", "/tmp/unused-job.json", "--target-version", "not-semver"], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be an exact semantic version/);
  assert.match(source, /verifyInstalledVersion\(packageName, globalRoot\)/);
  assert.match(source, /expected \$\{targetVersion\}, found/);
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
  assert.match(workflow, /publish_or_verify release\/npm\/server/);
  assert.doesNotMatch(workflow, /npm_tag="stable"/);
  assert.doesNotMatch(workflow, /npm dist-tag add .* latest/);
});

test("Docker releases map stable to latest and isolate preview tags", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker.yml"), "utf8");

  assert.match(workflow, /tags\+=\(--tag "\$\{image\}:latest"\)/);
  assert.match(workflow, /tags\+=\(--tag "\$\{image\}:\$\{channel\}"\)/);
  assert.doesNotMatch(workflow, /\$\{image\}:stable/);
});
