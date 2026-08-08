const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LocalDockerExecutor,
  assertDockerConfigHasNoSecrets,
  defaultCommandRunner,
} = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");

const enabled = process.env.TASK_HANDOFF_DOCKER_INTEGRATION === "1";
const baseImage = process.env.TASK_HANDOFF_DOCKER_TEST_IMAGE || "task-handoff-controlled-browser:local";

async function docker(args) {
  return defaultCommandRunner("docker", args, { timeoutMs: 120_000 });
}

async function bestEffort(args) {
  await docker(args).catch(() => undefined);
}

function volumeLabels(instanceId, role) {
  return {
    "task-handoff.owner": "task-handoff",
    "task-handoff.instance-id": instanceId,
    "task-handoff.node-id": "docker-integration-node",
    "task-handoff.volume-role": role,
  };
}

async function createVolume(name, instanceId, role) {
  const args = ["volume", "create"];
  for (const [key, value] of Object.entries(volumeLabels(instanceId, role))) {
    args.push("--label", `${key}=${value}`);
  }
  args.push(name);
  await docker(args);
}

async function inspect(reference) {
  return JSON.parse((await docker(["inspect", "--format", "{{json .}}", reference])).stdout);
}

test("real Docker commit excludes mounts and supports isolated derived environments", { skip: !enabled }, async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const prefix = `task-handoff-environment-it-${suffix}`;
  const sourceContainer = `${prefix}-source`;
  const gitContainer = `${prefix}-git-derived`;
  const localContainer = `${prefix}-local-derived`;
  const internalTag = `task-handoff/environment-template:integration-${suffix}`;
  const localWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-workspace-`));
  const containers = [sourceContainer, gitContainer, localContainer];
  const volumes = [];
  let imageId;

  t.after(async () => {
    for (const name of containers) await bestEffort(["rm", "-f", name]);
    await bestEffort(["image", "rm", internalTag]);
    if (imageId) await bestEffort(["image", "rm", imageId]);
    for (const name of volumes) await bestEffort(["volume", "rm", name]);
    fs.rmSync(localWorkspace, { recursive: true, force: true });
  });

  await docker(["image", "inspect", baseImage]);

  const sourceInstanceId = `${prefix}-source-instance`;
  const sourceVolumes = Object.fromEntries(["workspace", "data", "agent-home"].map((role) => {
    const name = `${prefix}-source-${role}`;
    volumes.push(name);
    return [role, name];
  }));
  for (const [role, name] of Object.entries(sourceVolumes)) await createVolume(name, sourceInstanceId, role);

  const sourceRun = await docker([
    "run", "-d", "--name", sourceContainer, "--user", "root", "--entrypoint", "sh",
    "--mount", `type=volume,src=${sourceVolumes.workspace},dst=/workspace`,
    "--mount", `type=volume,src=${sourceVolumes.data},dst=/data`,
    "--mount", `type=volume,src=${sourceVolumes["agent-home"]},dst=/home/agent`,
    baseImage, "-c",
    "printf layer-marker >/opt/environment-template-marker; printf workspace-marker >/workspace/source-marker; printf data-marker >/data/source-marker; printf home-marker >/home/agent/source-marker; sleep 300",
  ]);
  const sourceId = sourceRun.stdout.trim();
  assert.match(sourceId, /^[a-f0-9]{64}$/);

  const executor = new LocalDockerExecutor(defaultCommandRunner);
  const secretValues = [`registration-${suffix}`, `model-key-${suffix}`];
  await executor.inspectContainerConfigSecurity(sourceContainer, secretValues);
  imageId = await executor.commitEnvironmentTemplate(sourceContainer, sourceId, internalTag);
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);

  const image = await executor.inspectEnvironmentTemplateImage(internalTag);
  assert.equal(image.imageId, imageId);
  assert.equal(image.platform, "linux");
  assert.ok(image.architecture.length > 0);
  assert.ok(image.sizeBytes > 0);
  await executor.inspectImageConfigSecurity(internalTag, secretValues);
  const imageConfig = JSON.parse((await docker(["image", "inspect", "--format", "{{json .}}", internalTag])).stdout);
  assertDockerConfigHasNoSecrets(imageConfig, secretValues);
  assert.equal(secretValues.some((secret) => JSON.stringify(imageConfig).includes(secret)), false);

  const gitInstanceId = `${prefix}-git-instance`;
  const gitVolumes = Object.fromEntries(["workspace", "data", "agent-home"].map((role) => {
    const name = `${prefix}-git-${role}`;
    volumes.push(name);
    return [role, name];
  }));
  for (const [role, name] of Object.entries(gitVolumes)) await createVolume(name, gitInstanceId, role);
  await docker([
    "create", "--name", gitContainer, "--user", "root", "--entrypoint", "sh",
    "--mount", `type=volume,src=${gitVolumes.workspace},dst=/workspace`,
    "--mount", `type=volume,src=${gitVolumes.data},dst=/data`,
    "--mount", `type=volume,src=${gitVolumes["agent-home"]},dst=/home/agent`,
    imageId, "-c",
    "test \"$(cat /opt/environment-template-marker)\" = layer-marker && test ! -e /workspace/source-marker && test ! -e /data/source-marker && test ! -e /home/agent/source-marker",
  ]);
  assert.equal((await docker(["start", "-a", gitContainer])).stdout.trim(), "");

  fs.writeFileSync(path.join(localWorkspace, "local-marker"), "local-workspace", "utf8");
  const localInstanceId = `${prefix}-local-instance`;
  const localVolumes = Object.fromEntries(["data", "agent-home"].map((role) => {
    const name = `${prefix}-local-${role}`;
    volumes.push(name);
    return [role, name];
  }));
  for (const [role, name] of Object.entries(localVolumes)) await createVolume(name, localInstanceId, role);
  await docker([
    "create", "--name", localContainer, "--user", "root", "--entrypoint", "sh",
    "--mount", `type=bind,src=${localWorkspace},dst=/workspace`,
    "--mount", `type=volume,src=${localVolumes.data},dst=/data`,
    "--mount", `type=volume,src=${localVolumes["agent-home"]},dst=/home/agent`,
    imageId, "-c",
    "test \"$(cat /opt/environment-template-marker)\" = layer-marker && test \"$(cat /workspace/local-marker)\" = local-workspace && test ! -e /workspace/source-marker && test ! -e /data/source-marker && test ! -e /home/agent/source-marker",
  ]);
  assert.equal((await docker(["start", "-a", localContainer])).stdout.trim(), "");

  const gitInspect = await inspect(gitContainer);
  const mounts = new Map(gitInspect.Mounts.map((mount) => [mount.Destination, mount.Name || mount.Source]));
  assert.equal(mounts.get("/workspace"), gitVolumes.workspace);
  assert.equal(mounts.get("/data"), gitVolumes.data);
  assert.equal(mounts.get("/home/agent"), gitVolumes["agent-home"]);
  for (const [role, name] of Object.entries(gitVolumes)) {
    const volume = JSON.parse((await docker(["volume", "inspect", "--format", "{{json .}}", name])).stdout);
    assert.equal(volume.Labels["task-handoff.instance-id"], gitInstanceId);
    assert.equal(volume.Labels["task-handoff.volume-role"], role);
  }

  assert.equal(await executor.untagEnvironmentTemplate(internalTag), imageId);
  assert.equal(await executor.garbageCollectEnvironmentTemplateImage(imageId), false);
  await docker(["rm", gitContainer, localContainer]);
  assert.equal(await executor.garbageCollectEnvironmentTemplateImage(imageId), true);
  imageId = undefined;

  for (const name of gitVolumes ? Object.values(gitVolumes) : []) await docker(["volume", "rm", name]);
  for (const name of Object.values(localVolumes)) await docker(["volume", "rm", name]);
  const retained = Object.values(sourceVolumes);
  for (const name of retained) assert.equal(JSON.parse((await docker(["volume", "inspect", "--format", "{{json .Name}}", name])).stdout), name);
});
