import type { LocalDockerImage } from "@task-handoff/protocol/control-plane";
import { normalizeDockerImageReference } from "@task-handoff/protocol/control-plane";
import { defaultCommandRunner, type CommandRunner } from "../shared/process/command-runner.ts";

export type DockerImagePhase = "checking-image" | "pulling-image" | "resolving-image";
export type ResolvedDockerImage = {
  requestedReference: string;
  resolvedDigest?: string;
  resolvedReference: string;
  pulled: boolean;
};

type InFlightImage = {
  promise: Promise<ResolvedDockerImage>;
  listeners: Set<(phase: DockerImagePhase) => void>;
  phase?: DockerImagePhase;
};

export class DockerImageService {
  private readonly inFlight = new Map<string, InFlightImage>();
  private readonly runCommand: CommandRunner;

  constructor(runCommand: CommandRunner = defaultCommandRunner) {
    this.runCommand = runCommand;
  }

  ensure(referenceInput: string, onPhase?: (phase: DockerImagePhase) => void) {
    const reference = normalizeDockerImageReference(referenceInput);
    const existing = this.inFlight.get(reference);
    if (existing) {
      if (onPhase) {
        existing.listeners.add(onPhase);
        if (existing.phase) onPhase(existing.phase);
      }
      return existing.promise;
    }
    const listeners = new Set<(phase: DockerImagePhase) => void>();
    if (onPhase) listeners.add(onPhase);
    const entry: InFlightImage = { promise: Promise.resolve(undefined as never), listeners };
    const notify = (phase: DockerImagePhase) => {
      entry.phase = phase;
      listeners.forEach((listener) => listener(phase));
    };
    entry.promise = this.ensureOnce(reference, notify).finally(() => this.inFlight.delete(reference));
    this.inFlight.set(reference, entry);
    return entry.promise;
  }

  private async ensureOnce(reference: string, notify: (phase: DockerImagePhase) => void) {
    notify("checking-image");
    let inspected = await this.inspect(reference).catch(() => undefined);
    let pulled = false;
    if (!inspected) {
      notify("pulling-image");
      await this.runCommand("docker", ["pull", reference]);
      pulled = true;
      inspected = await this.inspect(reference);
    }
    notify("resolving-image");
    const repoDigest = dockerRepoDigests(inspected).find((item) => /@sha256:[a-fA-F0-9]{64}$/.test(item));
    const resolvedDigest = repoDigest?.split("@").at(-1)?.toLowerCase();
    return {
      requestedReference: reference,
      ...(resolvedDigest ? { resolvedDigest } : {}),
      resolvedReference: repoDigest || reference,
      pulled,
    };
  }

  private async inspect(reference: string) {
    const result = await this.runCommand("docker", ["image", "inspect", reference, "--format", "{{json .}}"]);
    return JSON.parse(result.stdout.trim() || "{}") as Record<string, unknown>;
  }
}

function dockerRepoDigests(record: Record<string, unknown>) {
  return Array.isArray(record.RepoDigests) ? record.RepoDigests.filter((item): item is string => typeof item === "string") : [];
}

export async function listDockerImages(runCommand: CommandRunner = defaultCommandRunner): Promise<LocalDockerImage[]> {
  const result = await runCommand("docker", ["images", "--digests", "--format", "{{json .}}"]);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const record = JSON.parse(line) as Record<string, string>;
    const repository = record.Repository || "<none>";
    const tag = record.Tag || "<none>";
    const id = record.ID || record.IDShort || "";
    const reference = repository !== "<none>" && tag !== "<none>" ? `${repository}:${tag}` : id;
    const repoDigests = repository !== "<none>" && record.Digest && record.Digest !== "<none>" ? [`${repository}@${record.Digest}`] : [];
    return { repository, tag, id, createdSince: record.CreatedSince, size: record.Size, reference, repoDigests };
  }).filter((image) => Boolean(image.reference));
}
