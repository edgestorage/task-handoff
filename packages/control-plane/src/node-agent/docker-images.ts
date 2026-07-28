import type { LocalDockerImage } from "@task-handoff/protocol/control-plane";
import { normalizeDockerImageReference } from "@task-handoff/protocol/control-plane";
import { defaultCommandRunner, type CommandRunner } from "../shared/process/command-runner.ts";
import { defaultTerminalCommandRunner, type TerminalCommandRunner } from "../shared/process/terminal-command-runner.ts";

export type DockerImagePhase = "checking-image" | "pulling-image" | "resolving-image";
export type ResolvedDockerImage = {
  requestedReference: string;
  resolvedDigest?: string;
  resolvedReference: string;
  pulled: boolean;
};

type InFlightImage = {
  promise: Promise<ResolvedDockerImage>;
  phaseListeners: Set<(phase: DockerImagePhase) => void>;
  terminalListeners: Set<(output: DockerImageTerminalOutput) => void>;
  phase?: DockerImagePhase;
  terminalSequence: number;
  terminalTail: string;
};

export type DockerImageTerminalOutput = {
  sequence: number;
  data: string;
  replay?: boolean;
};

const MAX_TERMINAL_TAIL = 256 * 1024;

export class DockerImageService {
  private readonly inFlight = new Map<string, InFlightImage>();
  private readonly runCommand: CommandRunner;
  private readonly runTerminalCommand: TerminalCommandRunner;

  constructor(runCommand: CommandRunner = defaultCommandRunner, runTerminalCommand?: TerminalCommandRunner) {
    this.runCommand = runCommand;
    this.runTerminalCommand = runTerminalCommand || terminalRunnerFromCommandRunner(runCommand);
  }

  ensure(referenceInput: string, onPhase?: (phase: DockerImagePhase) => void, onTerminal?: (output: DockerImageTerminalOutput) => void) {
    const reference = normalizeDockerImageReference(referenceInput);
    const existing = this.inFlight.get(reference);
    if (existing) {
      if (onPhase) {
        existing.phaseListeners.add(onPhase);
        if (existing.phase) onPhase(existing.phase);
      }
      if (onTerminal) {
        existing.terminalListeners.add(onTerminal);
        if (existing.terminalTail) onTerminal({ sequence: existing.terminalSequence, data: existing.terminalTail, replay: true });
      }
      return existing.promise;
    }
    const phaseListeners = new Set<(phase: DockerImagePhase) => void>();
    const terminalListeners = new Set<(output: DockerImageTerminalOutput) => void>();
    if (onPhase) phaseListeners.add(onPhase);
    if (onTerminal) terminalListeners.add(onTerminal);
    const entry: InFlightImage = {
      promise: Promise.resolve(undefined as never),
      phaseListeners,
      terminalListeners,
      terminalSequence: 0,
      terminalTail: "",
    };
    const notify = (phase: DockerImagePhase) => {
      entry.phase = phase;
      phaseListeners.forEach((listener) => listener(phase));
    };
    const notifyTerminal = (data: string) => {
      entry.terminalSequence += 1;
      entry.terminalTail = `${entry.terminalTail}${data}`.slice(-MAX_TERMINAL_TAIL);
      const output = { sequence: entry.terminalSequence, data };
      terminalListeners.forEach((listener) => listener(output));
    };
    entry.promise = this.ensureOnce(reference, notify, notifyTerminal).finally(() => this.inFlight.delete(reference));
    this.inFlight.set(reference, entry);
    return entry.promise;
  }

  private async ensureOnce(reference: string, notify: (phase: DockerImagePhase) => void, notifyTerminal: (data: string) => void) {
    notify("checking-image");
    let inspected = await this.inspect(reference).catch(() => undefined);
    let pulled = false;
    if (!inspected) {
      notify("pulling-image");
      await this.runTerminalCommand("docker", ["pull", reference], { cols: 120, rows: 40, onData: notifyTerminal });
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

function terminalRunnerFromCommandRunner(runCommand: CommandRunner): TerminalCommandRunner {
  if (runCommand === defaultCommandRunner) return defaultTerminalCommandRunner;
  return async (command, args, options = {}) => {
    const result = await runCommand(command, args, { timeoutMs: options.timeoutMs });
    if (result.stdout) options.onData?.(result.stdout);
    if (result.stderr) options.onData?.(result.stderr);
    return result;
  };
}

function dockerRepoDigests(record: Record<string, unknown>) {
  return Array.isArray(record.RepoDigests) ? record.RepoDigests.filter((item): item is string => typeof item === "string") : [];
}

export function parseDockerImageSize(input: string | undefined) {
  if (!input) return undefined;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|MB|GB|TB)$/i.exec(input.trim());
  if (!match) return undefined;
  const multipliers: Record<string, number> = { b: 1, kb: 1_000, mb: 1_000_000, gb: 1_000_000_000, tb: 1_000_000_000_000 };
  const value = Number(match[1]) * multipliers[match[2].toLowerCase()];
  return Number.isSafeInteger(Math.round(value)) ? Math.round(value) : undefined;
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
    return { repository, tag, id, createdSince: record.CreatedSince, size: record.Size, sizeBytes: parseDockerImageSize(record.Size), reference, repoDigests };
  }).filter((image) => Boolean(image.reference));
}
