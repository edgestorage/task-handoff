import {
  DEFAULT_IMAGE_COVER,
  MARKET_CATALOG_PROTOCOL_VERSION,
  MarketCatalogSnapshotSchema,
  MarketCatalogStatusSchema,
  parseDockerImageReference,
  type MarketCatalogSnapshot,
  type MarketCatalogStatus,
} from "@task-handoff/protocol/control-plane";

export interface MarketCatalogProvider {
  loadCatalog(): Promise<MarketCatalogSnapshot>;
}

function timestamp(input: string | undefined) {
  return input && !Number.isNaN(Date.parse(input)) ? new Date(input).toISOString() : new Date().toISOString();
}

function embeddedImage(input: {
  id: string;
  slug: string;
  name: string;
  description: string;
  localizedDescriptions?: Record<string, string>;
  reference: string;
  capabilities: string[];
  optionalApps: string[];
}) {
  const parsed = parseDockerImageReference(input.reference);
  const tag = parsed.tag || "latest";
  return {
    id: input.id,
    publisher: "task-handoff",
    slug: input.slug,
    name: input.name,
    description: input.description,
    localizedDescriptions: input.localizedDescriptions,
    cover: DEFAULT_IMAGE_COVER,
    repository: parsed.repository,
    defaultTag: tag,
    tags: [{ name: tag, reference: parsed.reference, platforms: [], status: "active" as const }],
    capabilities: input.capabilities,
    optionalApps: input.optionalApps,
    defaultEnv: {},
    labels: { "task-handoff.image.kind": "controlled-instance", "task-handoff.image.profile": input.slug },
    status: "active" as const,
  };
}

export function embeddedMarketCatalogSnapshot(): MarketCatalogSnapshot {
  const generatedAt = timestamp(process.env.TASK_HANDOFF_BUILT_AT);
  return MarketCatalogSnapshotSchema.parse({
    protocolVersion: MARKET_CATALOG_PROTOCOL_VERSION,
    catalogId: "task_handoff_embedded",
    revision: process.env.TASK_HANDOFF_VERSION || "0.0.1",
    source: "embedded",
    generatedAt,
    items: [
      embeddedImage({
        id: "market_taskhandoff_codex",
        slug: "codex",
        name: "TaskHandoff Codex",
        description: "Minimal Codex runtime with terminal and Codex.",
        localizedDescriptions: { "zh-CN": "最小 Codex 运行环境，包含终端和 Codex。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_CODEX_IMAGE || "huadream/task-handoff-controlled-codex:latest",
        capabilities: ["terminal", "codex"],
        optionalApps: ["terminal-tty"],
      }),
      embeddedImage({
        id: "market_taskhandoff_ai",
        slug: "ai",
        name: "TaskHandoff Codex + Claude",
        description: "AI development runtime with Codex, Claude, and terminal.",
        localizedDescriptions: { "zh-CN": "AI 开发运行环境，包含 Codex、Claude 和终端。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_AI_IMAGE || "huadream/task-handoff-controlled-ai:latest",
        capabilities: ["terminal", "codex", "claude"],
        optionalApps: ["terminal-tty"],
      }),
      embeddedImage({
        id: "market_taskhandoff_browser",
        slug: "browser",
        name: "TaskHandoff Browser",
        description: "Full runtime with Codex, Claude, Chromium, VNC, and code-server.",
        localizedDescriptions: { "zh-CN": "完整运行环境，包含 Codex、Claude、Chromium、VNC 和 code-server。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_BROWSER_IMAGE || "huadream/task-handoff-controlled-browser:latest",
        capabilities: ["browser", "terminal", "gui-terminal", "vscode-web", "codex", "claude"],
        optionalApps: ["chromium", "terminal-tty", "gui-terminal", "vscode-web"],
      }),
    ],
  });
}

export class EmbeddedMarketCatalogProvider implements MarketCatalogProvider {
  async loadCatalog() {
    return embeddedMarketCatalogSnapshot();
  }
}

export class MarketCatalogService {
  private snapshot: MarketCatalogSnapshot;
  private status: MarketCatalogStatus;

  constructor(initialSnapshot = embeddedMarketCatalogSnapshot()) {
    this.snapshot = MarketCatalogSnapshotSchema.parse(initialSnapshot);
    this.status = MarketCatalogStatusSchema.parse({
      source: this.snapshot.source,
      state: "ready",
      revision: this.snapshot.revision,
      updatedAt: this.snapshot.generatedAt,
    });
  }

  getCatalog() {
    return this.snapshot;
  }

  getStatus() {
    return this.status;
  }

  acceptCandidate(input: unknown) {
    const next = MarketCatalogSnapshotSchema.safeParse(input);
    if (!next.success) {
      this.status = MarketCatalogStatusSchema.parse({
        ...this.status,
        state: "failed",
        updatedAt: new Date().toISOString(),
        error: next.error.message,
      });
      return { accepted: false as const, error: next.error };
    }
    this.snapshot = next.data;
    this.status = MarketCatalogStatusSchema.parse({
      source: next.data.source,
      state: "ready",
      revision: next.data.revision,
      updatedAt: new Date().toISOString(),
    });
    return { accepted: true as const, snapshot: next.data };
  }

  recordRefreshFailure(error: unknown) {
    this.status = MarketCatalogStatusSchema.parse({
      ...this.status,
      state: this.snapshot ? "stale" : "failed",
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    return this.snapshot;
  }

  async refresh(provider: MarketCatalogProvider) {
    try {
      const candidate = await provider.loadCatalog();
      return this.acceptCandidate(candidate);
    } catch (error) {
      this.recordRefreshFailure(error);
      return { accepted: false as const, error };
    }
  }
}
