import crypto from "node:crypto";
import {
  GitSshHostKeyProbeRequestSchema,
  GitSshHostKeyProbeResponseSchema,
  normalizeGitCredentialScope,
  type GitSshHostKeyEntry,
  type GitSshHostKeyProbeResponse,
} from "@task-handoff/protocol/managed-git-credentials";
import { defaultCommandRunner, type CommandRunner } from "../../shared/process/command-runner.ts";

const DEFAULT_SSH_PORT = 22;
const PROBE_TIMEOUT_MS = 15_000;
// Preferred order: modern algorithms first so the pinned entry list stays stable.
const KEY_TYPE_ORDER = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"];

function probeError(message: string, code: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

function decodeKeyType(publicKey: Buffer) {
  if (publicKey.length < 4) return undefined;
  const length = publicKey.readUInt32BE(0);
  if (length <= 0 || length > 64 || publicKey.length < 4 + length) return undefined;
  const keyType = publicKey.subarray(4, 4 + length).toString("utf8");
  return /^[a-z0-9][a-z0-9-]*$/.test(keyType) ? keyType : undefined;
}

function fingerprintOf(publicKey: Buffer) {
  return `SHA256:${crypto.createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`;
}

/**
 * The pinned `known_hosts` first field must use the bracketed `[host]:port` form
 * for any non-default port. `ssh-keyscan` echoes the bare hostname it was given,
 * so the entry is rebuilt from the normalized scope rather than copied verbatim.
 */
function knownHostsHost(host: string, port: number) {
  return port === DEFAULT_SSH_PORT ? host : `[${host}]:${port}`;
}

export function parseSshKeyscanOutput(host: string, port: number, stdout: string): GitSshHostKeyEntry[] {
  const field = knownHostsHost(host, port);
  const entries: GitSshHostKeyEntry[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [, keyType, encoded] = line.split(/\s+/);
    if (!keyType || !encoded) continue;
    const publicKey = Buffer.from(encoded, "base64");
    if (publicKey.length === 0 || publicKey.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) continue;
    // The wire blob carries its own algorithm name; a mismatch means a malformed line.
    if (decodeKeyType(publicKey) !== keyType) continue;
    if (seen.has(keyType)) continue;
    seen.add(keyType);
    entries.push({
      keyType,
      fingerprint: fingerprintOf(publicKey),
      publicKey: encoded,
      knownHosts: `${field} ${keyType} ${encoded}`,
    });
  }
  return entries.sort((left, right) => {
    const leftIndex = KEY_TYPE_ORDER.indexOf(left.keyType);
    const rightIndex = KEY_TYPE_ORDER.indexOf(right.keyType);
    return (leftIndex < 0 ? KEY_TYPE_ORDER.length : leftIndex) - (rightIndex < 0 ? KEY_TYPE_ORDER.length : rightIndex);
  });
}

export async function probeGitSshHostKeys(input: unknown, runCommand: CommandRunner = defaultCommandRunner): Promise<GitSshHostKeyProbeResponse> {
  const parsed = GitSshHostKeyProbeRequestSchema.parse(input);
  const scope = normalizeGitCredentialScope({ scheme: "ssh", host: parsed.host, ...(parsed.port === undefined ? {} : { port: parsed.port }) });
  const host = scope.host;
  const port = scope.port ?? DEFAULT_SSH_PORT;
  let stdout: string;
  try {
    // `--` terminates option parsing so the host can never be read as a flag.
    stdout = (await runCommand("ssh-keyscan", ["-T", "10", "-p", String(port), "-t", "rsa,ecdsa,ed25519", "--", host], { timeoutMs: PROBE_TIMEOUT_MS })).stdout;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      throw probeError("ssh-keyscan is not available on the Control Plane host.", "GIT_SSH_HOST_KEY_PROBE_UNAVAILABLE", 501);
    }
    throw probeError("Could not reach the SSH host to read its host keys.", "GIT_SSH_HOST_KEY_PROBE_FAILED", 502);
  }
  const entries = parseSshKeyscanOutput(host, port, stdout);
  if (entries.length === 0) {
    throw probeError("The SSH host did not return a usable host key.", "GIT_SSH_HOST_KEY_PROBE_EMPTY", 502);
  }
  return GitSshHostKeyProbeResponseSchema.parse({
    host,
    port,
    fetchedAt: new Date().toISOString(),
    knownHosts: entries.map((entry) => entry.knownHosts).join("\n"),
    entries,
  });
}
