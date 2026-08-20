const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("runtime releases map stable to latest and isolate prerelease dist-tags", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "runtime-release.yml"), "utf8");

  assert.match(workflow, /npm_tag="latest"/);
  assert.match(workflow, /npm_tag="\$\{prerelease%%\.\*\}"/);
  assert.match(workflow, /"\$npm_tag" != "alpha" && "\$npm_tag" != "beta"/);
  assert.match(workflow, /NPM_DIST_TAG: \$\{\{ needs\.runtime-packages\.outputs\.npm_tag \}\}/);
  assert.match(workflow, /publish_or_verify\(\)/);
  assert.equal((workflow.match(/publish_or_verify release\/npm\/[a-z-]+ "release\/npm\/artifacts\//g) || []).length, 4);
  assert.match(workflow, /Published \$package@\$version integrity does not match/);
  assert.match(workflow, /npm publish "\$archive" --access public --tag "\$NPM_DIST_TAG"/);
  assert.doesNotMatch(workflow, /npm pack "\$directory"/);
  assert.match(workflow, /Keep prereleases out of the latest dist-tag/);
  assert.match(workflow, /if \[\[ "\$latest" == "\$RELEASE_VERSION" \]\]/);
  assert.match(workflow, /npm dist-tag rm "\$package" latest/);
  assert.doesNotMatch(workflow, /npm_tag="stable"/);
  assert.doesNotMatch(workflow, /npm dist-tag add .* latest/);
});

test("runtime release builds one Linux controlled-instance artifact from supported node-pty prebuilds", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "runtime-release.yml"), "utf8");

  for (const identity of ["linux-x64", "linux-arm64"]) {
    const [platform, arch] = identity.split("-");
    assert.match(workflow, new RegExp(`platform: ${platform}\\n\\s+arch: ${arch}`));
  }
  assert.doesNotMatch(workflow, /platform: (?:darwin|win32)/);
  assert.doesNotMatch(workflow, /Collect packaged node-pty prebuild/);
  assert.match(workflow, /node scripts\/node-pty-prebuild\.mjs build/);
  assert.match(workflow, /node:24-bullseye/);
  assert.match(workflow, /npm_config_nodedir=\/usr\/local/);
  assert.match(workflow, /pattern: node-pty-prebuild-\*/);
  assert.match(workflow, /Build Linux controlled instance production runtime/);
  assert.equal((workflow.match(/pnpm runtime:artifact -- --version/g) || []).length, 1);
  assert.match(workflow, /--prebuilds-dir release\/node-pty-prebuilds/);
  assert.match(workflow, /release\/runtime-artifacts\/\*/);
  assert.match(workflow, /needs: node-pty-prebuilds/);
  assert.match(workflow, /runtime-packages:\n\s+needs: controlled-instance-artifact/);
  assert.ok(workflow.indexOf("name: controlled-instance-runtime-${{ needs.controlled-instance-artifact.outputs.version }}") < workflow.indexOf("name: Build npm tarballs"));
  assert.match(workflow, /needs: \[controlled-instance-artifact, runtime-packages\]/);
  assert.match(workflow, /publish:\n[\s\S]*?env:\n\s+GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /merge-multiple: true/);
  assert.match(workflow, /gh release create[\s\S]*release\/runtime-artifacts\/\*/);
  assert.match(workflow, /gh release create .*--draft/);
  assert.match(workflow, /gh release edit .*--draft=false/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.ok(workflow.indexOf("Publish or verify immutable npm packages") < workflow.indexOf("gh release edit \"$GITHUB_REF_NAME\" --draft=false"));
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /persist-credentials: false/);
});

test("detached node update worker does not overwrite rollout completion after service restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-update-worker-race-"));
  const jobFile = path.join(directory, "job.json");
  const targetVersion = require(path.join(root, "package.json")).version;
  const timestamp = new Date().toISOString();
  fs.writeFileSync(jobFile, `${JSON.stringify({
    id: "update_race",
    nodeId: "node_1",
    source: "npm",
    channel: "stable",
    toVersion: targetVersion,
    artifactRef: `npm:@task-handoff/node-agent@${targetVersion}#sha512-d29ya2VyLXRlc3Q=`,
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 0,
      stoppedInstanceCount: 0,
      activeInstanceCount: 0,
      restartInstanceCount: 0,
      runningInstanceIds: [],
      stoppedInstanceIds: [],
      activeInstanceIds: [],
    },
    status: "queued",
    rollout: {
      phase: "queued",
      desiredVersion: targetVersion,
      expectedInstanceIds: [],
      expectedInstanceCount: 0,
      matchedInstanceCount: 0,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      deferredInstanceCount: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }, null, 2)}\n`);
  const npm = path.join(directory, "npm");
  const npmLog = path.join(directory, "npm.log");
  fs.writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${npmLog}"\nif [ "$1" = "view" ]; then\n  echo '"sha512-d29ya2VyLXRlc3Q="'\nelif [ "$1" = "prefix" ]; then\n  echo "${directory}"\nelif [ "$1" = "root" ]; then\n  echo "${directory}/lib/node_modules"\nelif [ "$1" = "install" ]; then\n  mkdir -p "${directory}/lib/node_modules/@task-handoff/node-agent"\n  printf '{"version":"${targetVersion}"}\\n' > "${directory}/lib/node_modules/@task-handoff/node-agent/package.json"\nfi\nexit 0\n`, { mode: 0o755 });
  const systemctl = path.join(directory, "systemctl");
  fs.writeFileSync(systemctl, `#!/bin/sh\n"${process.execPath}" -e 'const fs=require("fs");const p=process.env.JOB_FILE;const j=JSON.parse(fs.readFileSync(p,"utf8"));j.status="succeeded";j.rollout={...j.rollout,phase:"succeeded",nodeVersion:j.toVersion};j.completedAt=new Date().toISOString();fs.writeFileSync(p,JSON.stringify(j));'\n`, { mode: 0o755 });

  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "node-update-worker.cts"),
    "--job-file", jobFile,
    "--target-version", targetVersion,
    "--npm-command", npm,
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, JOB_FILE: jobFile },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "succeeded");
  const npmCalls = fs.readFileSync(npmLog, "utf8");
  assert.match(npmCalls, new RegExp(`view @task-handoff/node-agent@${targetVersion.replaceAll(".", "\\.")} dist\\.integrity --json`));
  assert.match(npmCalls, new RegExp(`install --global --prefix .* @task-handoff/node-agent@${targetVersion.replaceAll(".", "\\.")}`));
});

test("detached node update worker installs into the prefix that owns the running worker", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-update-worker-owned-prefix-"));
  const activePrefix = path.join(directory, "active");
  const ambientPrefix = path.join(directory, "ambient");
  const packagedWorker = path.join(activePrefix, "lib/node_modules/@task-handoff/node-agent/dist/node-update-worker.cts");
  fs.mkdirSync(path.dirname(packagedWorker), { recursive: true });
  fs.symlinkSync(path.join(root, "scripts", "node-update-worker.cts"), packagedWorker);
  const jobFile = path.join(directory, "job.json");
  const targetVersion = require(path.join(root, "package.json")).version;
  const timestamp = new Date().toISOString();
  fs.writeFileSync(jobFile, `${JSON.stringify({
    id: "update_owned_prefix",
    nodeId: "node_1",
    source: "npm",
    channel: "stable",
    toVersion: targetVersion,
    artifactRef: `npm:@task-handoff/node-agent@${targetVersion}#sha512-d29ya2VyLXRlc3Q=`,
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 0,
      stoppedInstanceCount: 0,
      activeInstanceCount: 0,
      restartInstanceCount: 0,
      runningInstanceIds: [],
      stoppedInstanceIds: [],
      activeInstanceIds: [],
    },
    status: "queued",
    rollout: {
      phase: "queued",
      desiredVersion: targetVersion,
      expectedInstanceIds: [],
      expectedInstanceCount: 0,
      matchedInstanceCount: 0,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      deferredInstanceCount: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }, null, 2)}\n`);
  const npm = path.join(directory, "npm");
  const npmLog = path.join(directory, "npm.log");
  fs.writeFileSync(npm, `#!/bin/sh
printf '%s\\n' "$*" >> "${npmLog}"
if [ "$1" = "view" ]; then
  echo '"sha512-d29ya2VyLXRlc3Q="'
elif [ "$1" = "prefix" ]; then
  echo "${ambientPrefix}"
elif [ "$1" = "root" ]; then
  shift
  prefix="${ambientPrefix}"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--prefix" ]; then prefix="$2"; break; fi
    shift
  done
  echo "$prefix/lib/node_modules"
elif [ "$1" = "install" ]; then
  shift
  prefix="${ambientPrefix}"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--prefix" ]; then prefix="$2"; shift 2; continue; fi
    shift
  done
  mkdir -p "$prefix/lib/node_modules/@task-handoff/node-agent"
  printf '{"version":"${targetVersion}"}\\n' > "$prefix/lib/node_modules/@task-handoff/node-agent/package.json"
fi
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(directory, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const result = spawnSync(process.execPath, [
    packagedWorker,
    "--job-file", jobFile,
    "--target-version", targetVersion,
    "--npm-command", npm,
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(activePrefix, "lib/node_modules/@task-handoff/node-agent/package.json"), "utf8")).version, targetVersion);
  assert.equal(fs.existsSync(path.join(ambientPrefix, "lib/node_modules/@task-handoff/node-agent/package.json")), false);
  const npmCalls = fs.readFileSync(npmLog, "utf8");
  assert.doesNotMatch(npmCalls, /^prefix --global$/m);
  assert.ok(npmCalls.includes(`root --global --prefix ${activePrefix}`));
  assert.ok(npmCalls.includes(`install --global --prefix ${activePrefix} @task-handoff/node-agent@${targetVersion}`));
});

test("detached node update worker updates both co-installed distributions even when the standalone package already has the target version", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "server-node-update-worker-"));
  const jobFile = path.join(directory, "job.json");
  const targetVersion = require(path.join(root, "package.json")).version;
  const timestamp = new Date().toISOString();
  fs.writeFileSync(jobFile, `${JSON.stringify({
    id: "update_server",
    nodeId: "node_1",
    source: "npm",
    channel: "stable",
    toVersion: targetVersion,
    artifactRef: `npm:@task-handoff/server@${targetVersion}#sha512-d29ya2VyLXRlc3Q=`,
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 0,
      stoppedInstanceCount: 0,
      activeInstanceCount: 0,
      restartInstanceCount: 0,
      runningInstanceIds: [],
      stoppedInstanceIds: [],
      activeInstanceIds: [],
    },
    status: "queued",
    rollout: {
      phase: "queued",
      desiredVersion: targetVersion,
      expectedInstanceIds: [],
      expectedInstanceCount: 0,
      matchedInstanceCount: 0,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      deferredInstanceCount: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }, null, 2)}\n`);
  const npm = path.join(directory, "npm");
  const npmLog = path.join(directory, "npm.log");
  const healthFile = path.join(directory, "control-plane-health.json");
  fs.writeFileSync(healthFile, JSON.stringify({
    data: {
      ok: true,
      build: { packageVersion: "0.0.0" },
    },
  }));
  fs.mkdirSync(path.join(directory, "lib/node_modules/@task-handoff/node-agent"), { recursive: true });
  fs.writeFileSync(path.join(directory, "lib/node_modules/@task-handoff/node-agent/package.json"), `{"version":"${targetVersion}"}\n`);
  fs.writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${npmLog}"\nif [ "$1" = "view" ]; then\n  echo '"sha512-d29ya2VyLXRlc3Q="'\nelif [ "$1" = "prefix" ]; then\n  echo "${directory}"\nelif [ "$1" = "root" ]; then\n  echo "${directory}/lib/node_modules"\nelif [ "$1" = "install" ]; then\n  case "$*" in\n    *'@task-handoff/server@'*)\n      mkdir -p "${directory}/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/control-plane"\n      mkdir -p "${directory}/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/node-agent"\n      mkdir -p "${directory}/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/controlled-instance"\n      printf '{"version":"${targetVersion}"}\\n' > "${directory}/lib/node_modules/@task-handoff/server/package.json"\n      printf '{"version":"${targetVersion}"}\\n' > "${directory}/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/control-plane/package.json"\n      printf '{"version":"${targetVersion}"}\\n' > "${directory}/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/node-agent/package.json"\n      printf '{"version":"${targetVersion}"}\\n' > "${directory}/lib/node_modules/@task-handoff/server/node_modules/@task-handoff/controlled-instance/package.json"\n      ;;\n    *'@task-handoff/node-agent@'*)\n      mkdir -p "${directory}/lib/node_modules/@task-handoff/node-agent"\n      printf '{"version":"${targetVersion}"}\\n' > "${directory}/lib/node_modules/@task-handoff/node-agent/package.json"\n      ;;\n  esac\nfi\nexit 0\n`, { mode: 0o755 });
  const systemctl = path.join(directory, "systemctl");
  const systemctlLog = path.join(directory, "systemctl.log");
  fs.writeFileSync(systemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${systemctlLog}"\nif [ "$*" = "restart task-handoff-control-plane.service" ]; then\n  printf '{"data":{"ok":true,"role":"control-plane","protocolVersion":"2026-07-01","build":{"component":"control-plane","packageVersion":"${targetVersion}"},"dataDir":"/tmp/task-handoff-control-plane","serverTime":"2026-08-12T00:00:00.000Z"}}\\n' > "${healthFile}"\nfi\nexit 0\n`, { mode: 0o755 });

  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "node-update-worker.cts"),
    "--job-file", jobFile,
    "--target-version", targetVersion,
    "--npm-command", npm,
    "--control-plane-health-url", "http://127.0.0.1:8081/api/health",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TASK_HANDOFF_UPDATE_WORKER_TEST_HEALTH_FILE: healthFile,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "restarting-node");
  const npmCalls = fs.readFileSync(npmLog, "utf8");
  assert.match(npmCalls, new RegExp(`install --global --prefix .* @task-handoff/server@${targetVersion.replaceAll(".", "\\.")}`));
  assert.match(npmCalls, new RegExp(`install --global --prefix .* @task-handoff/node-agent@${targetVersion.replaceAll(".", "\\.")}`));
  assert.ok(
    npmCalls.indexOf(`view @task-handoff/node-agent@${targetVersion} dist.integrity --json`)
      < npmCalls.indexOf(`install --global --prefix ${directory} @task-handoff/server@${targetVersion}`),
    "all installed package artifacts must be verified before either distribution is changed",
  );
  assert.deepEqual(fs.readFileSync(systemctlLog, "utf8").trim().split("\n"), [
    "restart task-handoff-control-plane.service",
    "restart task-handoff-node-agent.service",
  ]);
});

test("detached node update worker CAS preserves a terminal write between observation and commit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-update-worker-cas-"));
  const jobFile = path.join(directory, "job.json");
  const targetVersion = require(path.join(root, "package.json")).version;
  const timestamp = new Date().toISOString();
  fs.writeFileSync(jobFile, `${JSON.stringify({
    id: "update_cas",
    nodeId: "node_1",
    source: "npm",
    channel: "stable",
    toVersion: targetVersion,
    artifactRef: `npm:@task-handoff/node-agent@${targetVersion}#sha512-d29ya2VyLXRlc3Q=`,
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 0,
      stoppedInstanceCount: 0,
      activeInstanceCount: 0,
      restartInstanceCount: 0,
      runningInstanceIds: [],
      stoppedInstanceIds: [],
      activeInstanceIds: [],
    },
    status: "queued",
    rollout: {
      phase: "queued",
      desiredVersion: targetVersion,
      expectedInstanceIds: [],
      expectedInstanceCount: 0,
      matchedInstanceCount: 0,
      pendingInstanceCount: 0,
      failedInstanceCount: 0,
      deferredInstanceCount: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  }, null, 2)}\n`);
  const npm = path.join(directory, "npm");
  fs.writeFileSync(npm, `#!/bin/sh\nif [ "$1" = "view" ]; then\n  echo '"sha512-d29ya2VyLXRlc3Q="'\nelif [ "$1" = "prefix" ]; then\n  echo "${directory}"\nelif [ "$1" = "root" ]; then\n  echo "${directory}/lib/node_modules"\nelif [ "$1" = "install" ]; then\n  mkdir -p "${directory}/lib/node_modules/@task-handoff/node-agent"\n  printf '{"version":"${targetVersion}"}\\n' > "${directory}/lib/node_modules/@task-handoff/node-agent/package.json"\nfi\nexit 0\n`, { mode: 0o755 });
  const systemctlMarker = path.join(directory, "systemctl-called");
  const systemctl = path.join(directory, "systemctl");
  fs.writeFileSync(systemctl, `#!/bin/sh\ntouch "${systemctlMarker}"\nexit 0\n`, { mode: 0o755 });
  const hook = path.join(directory, "cas-hook.cjs");
  fs.writeFileSync(hook, `const fs=require("node:fs");module.exports=({jobFile,observed})=>{if(observed.status!=="updating-node")return;const current=JSON.parse(fs.readFileSync(jobFile,"utf8"));current.status="succeeded";current.rollout={...current.rollout,phase:"succeeded",nodeVersion:current.toVersion};current.completedAt=new Date().toISOString();fs.writeFileSync(jobFile,JSON.stringify(current));};\n`);

  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "node-update-worker.cts"),
    "--job-file", jobFile,
    "--target-version", targetVersion,
    "--npm-command", npm,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TASK_HANDOFF_UPDATE_WORKER_TEST_CAS_HOOK: hook,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "succeeded");
  assert.equal(fs.existsSync(systemctlMarker), false, "a superseded worker must stop before restarting the service");
});
