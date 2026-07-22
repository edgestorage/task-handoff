const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function git(cwd, args, options = {}) {
  return execFileSync(options.gitCommand || "git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...options,
  }).trim();
}

function createGitFixture(options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-git-fixture-"));
  const root = path.join(base, "repository");
  fs.mkdirSync(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Task Handoff Test"]);
  git(root, ["config", "user.email", "task-handoff@example.invalid"]);

  const fixture = {
    base,
    root,
    git: (args, commandOptions) => git(root, args, commandOptions),
    write(relativePath, content, mode) {
      const filePath = path.join(root, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, mode === undefined ? undefined : { mode });
      return filePath;
    },
    commit(message = "fixture commit") {
      git(root, ["add", "--all"]);
      git(root, ["commit", "-m", message, "--no-gpg-sign"]);
      return git(root, ["rev-parse", "HEAD"]);
    },
    createWorktree(name, branch = `fixture/${name}`) {
      const worktreePath = path.join(base, "worktrees", name);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(root, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
      return worktreePath;
    },
    createBareRemote(name = "origin") {
      const remotePath = path.join(base, `${name}.git`);
      fs.mkdirSync(remotePath);
      git(remotePath, ["init", "--bare"]);
      git(root, ["remote", "add", name, remotePath]);
      return remotePath;
    },
    createConflict(relativePath = "conflict.txt") {
      fixture.write(relativePath, "base\n");
      fixture.commit("conflict base");
      git(root, ["checkout", "-b", "fixture/conflict"]);
      fixture.write(relativePath, "branch\n");
      fixture.commit("conflict branch");
      git(root, ["checkout", "main"]);
      fixture.write(relativePath, "main\n");
      fixture.commit("conflict main");
      try {
        git(root, ["merge", "fixture/conflict"]);
      } catch {}
    },
    lockWorktree(worktreePath, reason = "fixture lock") {
      git(root, ["worktree", "lock", "--reason", reason, worktreePath]);
    },
    makeWorktreePrunable(worktreePath) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    },
    createFileBoundaryCases() {
      const external = path.join(base, "outside.txt");
      fs.writeFileSync(external, "outside\n");
      fs.symlinkSync(external, path.join(root, "outside-link"));
      fs.mkdirSync(path.join(root, "submodule"), { recursive: true });
      fs.writeFileSync(path.join(root, "submodule", ".git"), "gitdir: ../.git/modules/submodule\n");
      fs.mkdirSync(path.join(root, "nested", ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]));
      fs.writeFileSync(path.join(root, "large.txt"), Buffer.alloc(5 * 1024 * 1024, 97));
      fs.writeFileSync(path.join(root, "executable.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      return { external };
    },
    installFailingHook(name = "pre-commit") {
      const hookPath = path.join(root, ".git", "hooks", name);
      fs.writeFileSync(hookPath, `#!/bin/sh\necho '${name} hook failed' >&2\nexit 1\n`, { mode: 0o755 });
      return hookPath;
    },
    clearIdentity() {
      git(root, ["config", "user.name", ""]);
      git(root, ["config", "user.email", ""]);
    },
  };

  if (options.initialCommit !== false) {
    fixture.write("tracked.txt", "initial\n");
    fixture.commit("initial commit");
  }
  return fixture;
}

module.exports = { createGitFixture, git };
