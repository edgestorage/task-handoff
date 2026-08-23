import fs from "node:fs";
import type { AiSessionRegistry } from "./ai-session-registry";
import { reconcileActiveAiProcesses, scanClaudeAppSessionBindings, scanRecentTranscripts } from "./ai-session-registry";

export type AiSessionAppSession = {
  id?: unknown;
  appId?: unknown;
  title?: unknown;
  status?: unknown;
  createdAt?: unknown;
  launch?: Record<string, unknown>;
  tty?: Record<string, unknown>;
  ai?: Record<string, unknown>;
};

export type AiSessionDiscoveryContext = {
  registry: AiSessionRegistry;
  appSessions: AiSessionAppSession[];
};

export type AiSessionDiscoveryProvider = {
  readonly id: string;
  refresh: (context: AiSessionDiscoveryContext) => Promise<void> | void;
};

export type AiSessionDiscoveryErrorHandler = (input: {
  providerId: string;
  error: unknown;
}) => void;

export class AiSessionDiscoveryCoordinator {
  private readonly providers = new Map<string, AiSessionDiscoveryProvider>();

  constructor(private readonly onProviderError?: AiSessionDiscoveryErrorHandler) {}

  register(provider: AiSessionDiscoveryProvider) {
    this.providers.set(provider.id, provider);
  }

  async refresh(context: AiSessionDiscoveryContext) {
    for (const provider of this.providers.values()) {
      try {
        await provider.refresh(context);
      } catch (error) {
        this.onProviderError?.({ providerId: provider.id, error });
      }
    }
  }
}

export class ClaudeAppSessionBindingProvider implements AiSessionDiscoveryProvider {
  readonly id = "claude-app-session-binding";

  refresh(context: AiSessionDiscoveryContext) {
    scanClaudeAppSessionBindings(context.registry, context.appSessions);
  }
}

export class RecentTranscriptDiscoveryProvider implements AiSessionDiscoveryProvider {
  readonly id = "recent-transcript-discovery";

  refresh(context: AiSessionDiscoveryContext) {
    if (envFlag("TASK_HANDOFF_AI_SESSION_SCAN", true)) {
      scanRecentTranscripts(context.registry);
    }
  }
}

export class ActiveAiProcessDiscoveryProvider implements AiSessionDiscoveryProvider {
  readonly id = "active-ai-process-discovery";

  refresh(context: AiSessionDiscoveryContext) {
    if (envFlag("TASK_HANDOFF_AI_PROCESS_SCAN", true)) {
      reconcileActiveAiProcesses(context.registry);
    }
  }
}

type AiTranscriptTailState = {
  offset: number;
  partial: string;
  calls: Map<string, never>;
  promptCounts?: Map<string, number>;
  activeTurnId?: string;
};

export class TranscriptTailDiscoveryProvider implements AiSessionDiscoveryProvider {
  readonly id = "transcript-tail-discovery";
  private readonly tailState = new Map<string, AiTranscriptTailState>();

  refresh(context: AiSessionDiscoveryContext) {
    syncAiSessionTranscripts(context.registry, this.tailState);
  }
}

export function syncAiSessionTranscripts(registry: AiSessionRegistry, tailState: Map<string, AiTranscriptTailState>) {
  for (const session of registry.list()) {
    if (!session.transcriptPath || session.status === "failed") {
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(session.transcriptPath);
    } catch {
      continue;
    }
    const state = tailState.get(session.id) || {
      offset: Math.max(0, stat.size - 64 * 1024),
      partial: "",
      calls: new Map<string, never>(),
      promptCounts: new Map<string, number>(),
    };
    if (stat.size < state.offset) {
      state.offset = 0;
      state.partial = "";
      state.calls.clear();
      state.promptCounts?.clear();
      state.activeTurnId = undefined;
    }
    if (stat.size === state.offset) {
      tailState.set(session.id, state);
      continue;
    }
    const chunk = fs.readFileSync(session.transcriptPath).subarray(state.offset).toString("utf8");
    state.offset = stat.size;
    state.partial += chunk;
    const lines = state.partial.split(/\r?\n/);
    state.partial = lines.pop() || "";
    for (const line of lines) {
      registry.ingestTranscriptLine(session.id, line, state);
    }
    tailState.set(session.id, state);
  }
}

function envFlag(name: string, fallback = false) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}
