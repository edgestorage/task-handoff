import { RuntimeArtifactIdentitySchema, type RuntimeArtifactIdentity } from "@task-handoff/protocol/control-plane";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RuntimeArtifactError, type RuntimeArtifactSource } from "./runtime-artifacts.ts";

export type PublishedRuntimeArtifact = {
  identity: RuntimeArtifactIdentity;
  source: RuntimeArtifactSource;
};

function releaseRoot(version: string) {
  const configured = process.env.TASK_HANDOFF_RUNTIME_RELEASE_BASE_URL?.trim();
  if (configured) return configured.replaceAll("{version}", version).replace(/\/$/, "");
  return `https://github.com/edgestorage/task-handoff/releases/download/v${version}`;
}

function bundledRuntimeRoot() {
  const configured = process.env.TASK_HANDOFF_BUNDLED_RUNTIME_DIR?.trim();
  return path.resolve(configured || path.join(path.dirname(process.argv[1] || process.cwd()), "..", "runtime-artifacts"));
}

async function resolveBundledRuntimeArtifact(version: string): Promise<PublishedRuntimeArtifact | undefined> {
  const stem = `controlled-instance-runtime-${version}-linux-universal`;
  const root = bundledRuntimeRoot();
  try {
    const [manifestText, checksumText] = await Promise.all([
      readFile(path.join(root, `${stem}.manifest.json`), "utf8"),
      readFile(path.join(root, `${stem}.tar.gz.sha256`), "utf8"),
    ]);
    const parsed = RuntimeArtifactIdentitySchema.safeParse(JSON.parse(manifestText));
    if (!parsed.success || parsed.data.version !== version || parsed.data.platform !== "linux" || parsed.data.arch !== "universal") {
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Bundled controlled-instance ${version} has an invalid Linux manifest.`);
    }
    const checksum = checksumText.trim().split(/\s+/)[0]?.toLowerCase();
    if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
      throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Bundled controlled-instance ${version} has an invalid archive checksum.`);
    }
    return {
      identity: parsed.data,
      source: { archivePath: path.join(root, `${stem}.tar.gz`), archiveSha256: checksum },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof RuntimeArtifactError) throw error;
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Could not read bundled controlled-instance ${version}.`, { cause: error });
  }
}

export async function resolvePublishedRuntimeArtifact(
  version: string,
  platform: string,
  arch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedRuntimeArtifact> {
  if (platform !== "linux" || !["x64", "arm64"].includes(arch)) {
    throw new RuntimeArtifactError(
      "INSTANCE_BASE_RUNTIME_INCOMPATIBLE",
      `Managed controlled-instance updates require a Linux x64 or arm64 target, received ${platform}/${arch}.`,
    );
  }
  const bundled = await resolveBundledRuntimeArtifact(version);
  if (bundled) return bundled;
  const stem = `controlled-instance-runtime-${version}-linux-universal`;
  const root = releaseRoot(version);
  const manifestUrl = `${root}/${stem}.manifest.json`;
  const archiveUrl = `${root}/${stem}.tar.gz`;
  const checksumUrl = `${root}/${stem}.tar.gz.sha256`;
  const [manifestResponse, checksumResponse] = await Promise.all([
    fetchImpl(manifestUrl),
    fetchImpl(checksumUrl),
  ]).catch((cause) => {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE", `Could not read release metadata for controlled-instance ${version}.`, { cause, retryable: true });
  });
  if (!manifestResponse.ok || !checksumResponse.ok) {
    throw new RuntimeArtifactError(
      "INSTANCE_RUNTIME_ARTIFACT_UNAVAILABLE",
      `Release metadata for controlled-instance ${version} is unavailable (manifest HTTP ${manifestResponse.status}, checksum HTTP ${checksumResponse.status}).`,
      { retryable: manifestResponse.status >= 500 || checksumResponse.status >= 500 },
    );
  }
  let manifest: unknown;
  try {
    manifest = await manifestResponse.json();
  } catch (cause) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Release manifest for controlled-instance ${version} is not valid JSON.`, { cause });
  }
  const parsed = RuntimeArtifactIdentitySchema.safeParse(manifest);
  if (!parsed.success) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Release manifest for controlled-instance ${version} is invalid: ${parsed.error.message}`);
  }
  if (parsed.data.version !== version || parsed.data.platform !== "linux" || parsed.data.arch !== "universal") {
    throw new RuntimeArtifactError(
      "INSTANCE_RUNTIME_ARTIFACT_INVALID",
      `Release identity mismatch: requested ${version}-linux-universal, received ${parsed.data.version}-${parsed.data.platform}-${parsed.data.arch}.`,
    );
  }
  const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0]?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) {
    throw new RuntimeArtifactError("INSTANCE_RUNTIME_ARTIFACT_INVALID", `Release checksum for controlled-instance ${version} is invalid.`);
  }
  return { identity: parsed.data, source: { archiveUrl, archiveSha256: checksum } };
}
