import fs from "node:fs";
import path from "node:path";
import {
  resolveGitCredential,
  type GitCredentialMatchCandidate,
} from "@task-handoff/protocol/managed-git-credentials";
import { parseGitSshInvocation, remoteFromHttpsCredentialRequest, runSsh } from "./git-transport.ts";

const DEFAULT_RUNTIME_DIR = "/run/task-handoff/git-runtime";

function provisioningFailure(status: string) {
  const marker = status.replace(/-/g, "_").toUpperCase();
  return Object.assign(new Error(`TASK_HANDOFF_GIT_PROVISIONING_ERROR=${marker}`), { code: marker });
}

function readCredentialInput() {
  return new Promise<Record<string, string>>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(Object.fromEntries(input.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf("=");
      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
    }))));
  });
}

function credentialCandidates(runtimeDir: string) {
  return fs.readdirSync(runtimeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("credential-"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const directory = path.join(runtimeDir, entry.name);
      const scopePath = path.join(directory, "scope.json");
      if (!fs.existsSync(scopePath)) return [];
      const hasToken = fs.existsSync(path.join(directory, "token"));
      const hasSshIdentity = fs.existsSync(path.join(directory, "public-identity"));
      if (!hasToken && !hasSshIdentity) return [];
      const candidate: GitCredentialMatchCandidate = {
        id: entry.name,
        kind: hasToken ? "https-token" : "ssh-key",
        scope: JSON.parse(fs.readFileSync(scopePath, "utf8")),
        status: "enabled",
        ...(hasSshIdentity ? { pinnedKnownHosts: fs.existsSync(path.join(directory, "known_hosts")) } : {}),
      };
      return [{ candidate, directory }];
    });
}

function selectCredential(remote: string, runtimeDir = process.env.TASK_HANDOFF_GIT_RUNTIME_DIR || DEFAULT_RUNTIME_DIR) {
  const entries = credentialCandidates(runtimeDir);
  const match = resolveGitCredential(remote, entries.map((entry) => entry.candidate));
  if (match.status !== "unique") throw provisioningFailure(match.status === "none" ? "credential-missing" : match.status);
  const selected = entries.find((entry) => entry.candidate.id === match.credential.id);
  if (!selected) throw provisioningFailure("credential-missing");
  return selected.directory;
}

export async function runProvisioningGitCredentialHelper(action: string | undefined) {
  if (action !== "get") return;
  const input = await readCredentialInput();
  const remote = remoteFromHttpsCredentialRequest(input);
  if (!remote) throw provisioningFailure("remote-unsupported");
  let directory: string;
  try {
    directory = selectCredential(remote);
  } catch (error) {
    if ((error as { code?: string }).code === "CREDENTIAL_MISSING") {
      process.stderr.write(`${(error as Error).message}\n`);
      return;
    }
    throw error;
  }
  const username = fs.readFileSync(path.join(directory, "username"), "utf8");
  const token = fs.readFileSync(path.join(directory, "token"), "utf8");
  process.stdout.write(`username=${username}\npassword=${token}\n\n`);
}

export async function runProvisioningGitSsh(args: string[]) {
  const invocation = parseGitSshInvocation(args);
  if (!invocation) throw provisioningFailure("remote-unsupported");
  const directory = selectCredential(invocation.remote);
  const agentSocket = path.join(directory, "agent.sock");
  const publicIdentity = path.join(directory, "public-identity");
  const knownHosts = path.join(directory, "known_hosts");
  if (!fs.existsSync(agentSocket)) throw provisioningFailure("ssh-agent-unavailable");
  if (!fs.existsSync(knownHosts) || fs.statSync(knownHosts).size === 0) throw provisioningFailure("host-key-required");
  return runSsh([
    "-F", "/dev/null",
    "-oBatchMode=yes",
    "-oPasswordAuthentication=no",
    "-oKbdInteractiveAuthentication=no",
    "-oIdentitiesOnly=yes",
    "-oIdentityFile=none",
    "-oStrictHostKeyChecking=yes",
    `-oUserKnownHostsFile=${knownHosts}`,
    "-oGlobalKnownHostsFile=/dev/null",
    `-oIdentityAgent=${agentSocket}`,
    "-i", publicIdentity,
    ...invocation.args,
  ], true, { SSH_AUTH_SOCK: agentSocket });
}

export const gitProvisioningCredentialsForTest = { credentialCandidates, selectCredential };
