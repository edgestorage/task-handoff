import fs from "node:fs";
import path from "node:path";

export function gitHelperAssets(implementation) {
  if (implementation === "node") return ["git-provisioning-helper", "git-provisioning-helper.js"];
  if (implementation === "rust") return ["git-provisioning-helper", ...["x64", "arm64"].map((arch) => `controlled-instance-linux-${arch}`)];
  throw new Error(`Unknown controlled-instance implementation: ${implementation}`);
}

// Keep the shell provisioning contract identical across implementations. Only
// the selected payload is copied; the launcher never discovers another runtime.
export function prepareGitHelper({ implementation, dockerDir, nodeHelper, binariesDir }) {
  fs.mkdirSync(dockerDir, { recursive: true });
  for (const name of new Set([...gitHelperAssets("node"), ...gitHelperAssets("rust")])) {
    fs.rmSync(path.join(dockerDir, name), { force: true });
  }
  const sources = implementation === "node"
    ? [[nodeHelper, "git-provisioning-helper.js"]]
    : gitHelperAssets(implementation).slice(1).map((name) => [path.join(binariesDir, name), name]);
  for (const [source, name] of sources) {
    fs.copyFileSync(source, path.join(dockerDir, name));
    fs.chmodSync(path.join(dockerDir, name), 0o755);
  }
  const command = implementation === "node"
    ? 'exec "$helper_dir/js-runtime.sh" "$helper_dir/git-provisioning-helper.js" "$@"'
    : `case "$(uname -m)" in
  x86_64|amd64) helper_arch=x64 ;;
  aarch64|arm64) helper_arch=arm64 ;;
  *) echo 'TASK_HANDOFF_GIT_PROVISIONING_ERROR=HELPER_UNAVAILABLE' >&2; exit 69 ;;
esac
exec "$helper_dir/controlled-instance-linux-$helper_arch" git-provisioning-helper "$@"`;
  fs.writeFileSync(path.join(dockerDir, "git-provisioning-helper"), `#!/bin/sh
set -eu
helper_dir="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
${command}
`, { mode: 0o755 });
}

export function checkGitHelper(dockerDir, implementation) {
  const required = gitHelperAssets(implementation);
  const requiresExecutableMode = process.platform !== "win32";
  for (const name of required) {
    const stats = fs.statSync(path.join(dockerDir, name), { throwIfNoEntry: false });
    if (!stats?.isFile() || (requiresExecutableMode && (stats.mode & 0o111) === 0)) {
      throw new Error(`Missing executable Git provisioning helper: ${name}.`);
    }
  }
  const other = gitHelperAssets(implementation === "node" ? "rust" : "node").filter((name) => !required.includes(name));
  if (other.some((name) => fs.existsSync(path.join(dockerDir, name)))) {
    throw new Error(`Git provisioning helpers contain unselected runtime payloads (${implementation}).`);
  }
}
