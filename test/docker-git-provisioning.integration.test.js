const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { defaultCommandRunner, dockerGitProvisionArgs } = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");

const enabled = process.env.TASK_HANDOFF_DOCKER_GIT_INTEGRATION === "1";
const image = process.env.TASK_HANDOFF_DOCKER_TEST_IMAGE || "task-handoff-controlled-browser:local";
const timestamp = "2026-08-23T00:00:00.000Z";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function server(root, key, certificate, authorization) {
  return https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(certificate) }, (request, response) => {
    if (request.headers.authorization !== authorization) {
      response.writeHead(401, { "www-authenticate": "Basic realm=git" });
      response.end("Authentication required.");
      return;
    }
    const url = new URL(request.url, "https://host.docker.internal");
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] || "", CONTENT_LENGTH: request.headers["content-length"] || "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    backend.stdout.on("data", (chunk) => output.push(chunk));
    request.pipe(backend.stdin);
    backend.once("close", () => {
      const body = Buffer.concat(output);
      const separator = body.indexOf("\r\n\r\n");
      const headerEnd = separator >= 0 ? separator + 4 : body.indexOf("\n\n") + 2;
      const headers = {};
      let status = 200;
      for (const line of body.subarray(0, headerEnd).toString("utf8").split(/\r?\n/)) {
        const index = line.indexOf(":");
        if (index <= 0) continue;
        const name = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ", 1)[0]);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      response.end(body.subarray(headerEnd));
    });
  });
}

function credential(id, pathPrefix, token) {
  return {
    operationId: `gitcredop_${id}`, retention: "instance-retained",
    payload: {
      credential: {
        id, name: id, kind: "https-token", scope: { scheme: "https", host: "host.docker.internal", pathPrefix },
        secretSet: true, status: "enabled", revision: 1, createdAt: timestamp, updatedAt: timestamp,
      },
      secret: { kind: "https-token", username: "git-user", token },
    },
  };
}

test("real Docker helper recursively provisions independently scoped HTTPS remotes", { skip: !enabled }, async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-git-provision-${suffix}-`));
  const auth = path.join(root, "auth");
  const container = `task-handoff-git-provision-${suffix}`;
  const token = `docker-secret-${suffix}`;
  const username = "git-user";
  fs.mkdirSync(auth, { mode: 0o700 });
  t.after(async () => {
    await defaultCommandRunner("docker", ["rm", "-f", container]).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const key = path.join(root, "key.pem");
  const certificate = path.join(root, "cert.pem");
  const opensslConfig = path.join(root, "openssl.cnf");
  fs.writeFileSync(opensslConfig, "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=host.docker.internal\n[v3]\nsubjectAltName=DNS:host.docker.internal\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", certificate, "-config", opensslConfig], { stdio: "ignore" });

  for (const relative of ["root/main.git", "team/sub.git"]) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    git(root, ["init", "-q", "--bare", relative]);
  }
  const subSeed = path.join(root, "sub-seed");
  git(root, ["init", "-q", subSeed]);
  fs.writeFileSync(path.join(subSeed, "sub.txt"), "submodule\n");
  git(root, ["-C", subSeed, "add", "sub.txt"]);
  git(root, ["-C", subSeed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "sub"]);
  git(root, ["-C", subSeed, "push", "-q", path.join(root, "team/sub.git"), "HEAD:main"]);
  git(root, ["--git-dir", path.join(root, "team/sub.git"), "symbolic-ref", "HEAD", "refs/heads/main"]);
  const subCommit = git(root, ["-C", subSeed, "rev-parse", "HEAD"]);

  const mainSeed = path.join(root, "main-seed");
  git(root, ["init", "-q", mainSeed]);
  fs.writeFileSync(path.join(mainSeed, "README.md"), "main\n");
  fs.writeFileSync(path.join(mainSeed, ".gitmodules"), "[submodule \"deps/sub\"]\n\tpath = deps/sub\n\turl = REPLACE_AFTER_LISTEN\n");
  git(root, ["-C", mainSeed, "add", "README.md", ".gitmodules"]);
  git(root, ["-C", mainSeed, "update-index", "--add", "--cacheinfo", `160000,${subCommit},deps/sub`]);

  const http = server(root, key, certificate, `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`);
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "0.0.0.0", resolve); });
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const port = http.address().port;
  fs.writeFileSync(path.join(mainSeed, ".gitmodules"), fs.readFileSync(path.join(mainSeed, ".gitmodules"), "utf8").replace("REPLACE_AFTER_LISTEN", `https://host.docker.internal:${port}/team/sub.git`));
  git(root, ["-C", mainSeed, "add", ".gitmodules"]);
  git(root, ["-C", mainSeed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "main"]);
  const historicalMainCommit = git(root, ["-C", mainSeed, "rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(subSeed, "sub.txt"), "submodule-v2\n");
  git(root, ["-C", subSeed, "add", "sub.txt"]);
  git(root, ["-C", subSeed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "sub-v2"]);
  git(root, ["-C", subSeed, "push", "-q", path.join(root, "team/sub.git"), "HEAD:main"]);
  const latestSubCommit = git(root, ["-C", subSeed, "rev-parse", "HEAD"]);
  git(root, ["-C", mainSeed, "update-index", "--cacheinfo", `160000,${latestSubCommit},deps/sub`]);
  git(root, ["-C", mainSeed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "main-v2"]);
  git(root, ["-C", mainSeed, "push", "-q", path.join(root, "root/main.git"), "HEAD:main"]);
  git(root, ["--git-dir", path.join(root, "root/main.git"), "symbolic-ref", "HEAD", "refs/heads/main"]);

  const credentials = [credential("main", "/root/", token), credential("sub", "/team/", token)];
  credentials.forEach((item, index) => {
    const directory = path.join(auth, `credential-${index}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, "scope.json"), JSON.stringify({ ...item.payload.credential.scope, port }), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "username"), username, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "token"), token, { mode: 0o600 });
  });
  const context = {
    node: { id: "docker-integration-node" },
    instance: { id: `integration-${suffix}` },
    image: { requestedReference: image },
    project: {
      source: { type: "git-repository" },
      workspacePolicy: { mode: "git-clone", path: "/workspace", readOnly: false },
    },
    gitWorkspaceProvisioning: {
      operationId: `gitop-${suffix}`, instanceId: `integration-${suffix}`,
      remoteUrl: `https://host.docker.internal:${port}/root/main.git`,
      ref: { type: "commit", commit: historicalMainCommit }, clone: { submodules: true, lfs: false, subdirectory: "" }, credentials,
    },
  };
  const expectedVolume = `task-handoff-${context.instance.id}-workspace`;
  await defaultCommandRunner("docker", ["volume", "rm", "-f", expectedVolume]).catch(() => undefined);
  await defaultCommandRunner("docker", ["volume", "create", expectedVolume]);
  t.after(() => defaultCommandRunner("docker", ["volume", "rm", "-f", expectedVolume]).catch(() => undefined));
  const args = dockerGitProvisionArgs(context, container, auth, { launcherAssetsDir: path.resolve("docker") });
  args.splice(args.length - 4, 0, "-e", "GIT_SSL_NO_VERIFY=1");
  assert.equal(args.some((value) => value.includes(token)), false);
  await defaultCommandRunner("docker", args, { timeoutMs: 120_000 });
  const workspaceInspection = await defaultCommandRunner("docker", ["run", "--rm", "--entrypoint", "sh", "--mount", `type=volume,src=${expectedVolume},dst=/workspace`, image, "-c", "test -f /workspace/README.md && test \"$(cat /workspace/deps/sub/sub.txt)\" = submodule && test ! -e /workspace/.task-handoff-git-provisioning && find /workspace -type f -maxdepth 5 -exec cat {} +"]);
  assert.equal(workspaceInspection.stdout.includes(token), false);
  await assert.rejects(() => defaultCommandRunner("docker", ["inspect", container]));
});
