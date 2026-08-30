import {
  runProvisioningGitCredentialHelper,
  runProvisioningGitSsh,
} from "@task-handoff/controlled-instance/web/git-provisioning-credentials";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "credential") return runProvisioningGitCredentialHelper(args[0]);
  if (command === "ssh") return runProvisioningGitSsh(args);
  throw new Error("TASK_HANDOFF_GIT_PROVISIONING_ERROR=REMOTE_UNSUPPORTED");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
