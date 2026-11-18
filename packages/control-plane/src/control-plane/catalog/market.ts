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
        id: "market_taskhandoff_base",
        slug: "base",
        name: "TaskHandoff Base",
        description: "Base runtime with terminal only. No AI CLIs, browser, VNC, or desktop environment is bundled.",
        localizedDescriptions: { "zh-CN": "仅包含终端的基础运行环境，不预装 AI CLI、浏览器、VNC 或桌面环境。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_BASE_IMAGE || "huadream/task-handoff-controlled-base:latest",
        capabilities: ["terminal"],
        optionalApps: ["terminal-tty"],
      }),
      embeddedImage({
        id: "market_taskhandoff_desktop_minimal",
        slug: "desktop-minimal",
        name: "TaskHandoff Desktop Minimal",
        description: "Minimal X11 desktop with Xvfb, Openbox, Tint2, jgmenu, and terminal. No AI CLIs, browser, VNC, or Remote Desktop is bundled.",
        localizedDescriptions: { "zh-CN": "包含 Xvfb、Openbox、Tint2、jgmenu 和终端的最小 X11 桌面，不预装 AI CLI、浏览器、VNC 或远程桌面。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_DESKTOP_MINIMAL_IMAGE || "huadream/task-handoff-controlled-desktop-minimal:latest",
        capabilities: ["terminal"],
        optionalApps: ["terminal-tty"],
      }),
      embeddedImage({
        id: "market_taskhandoff_desktop_xfce",
        slug: "desktop-xfce",
        name: "TaskHandoff Desktop Xfce",
        description: "Complete X11 Xfce desktop with D-Bus and terminal. No AI CLIs, browser, VNC, or Remote Desktop is bundled.",
        localizedDescriptions: { "zh-CN": "包含 D-Bus 和终端的完整 X11 Xfce 桌面，不预装 AI CLI、浏览器、VNC 或远程桌面。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_DESKTOP_XFCE_IMAGE || "huadream/task-handoff-controlled-desktop-xfce:latest",
        capabilities: ["terminal"],
        optionalApps: ["terminal-tty"],
      }),
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
        id: "market_taskhandoff_obscura",
        slug: "obscura",
        name: "TaskHandoff Obscura",
        description: "Codex runtime with terminal, Codex, and Obscura.",
        localizedDescriptions: { "zh-CN": "包含终端、Codex 和 Obscura 的运行环境。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_OBSCURA_IMAGE || "huadream/task-handoff-controlled-obscura:latest",
        capabilities: ["terminal", "codex", "obscura"],
        optionalApps: ["terminal-tty"],
      }),
      embeddedImage({
        id: "market_taskhandoff_rea",
        slug: "rea",
        name: "TaskHandoff REA",
        description: "Codex runtime with terminal, Codex, and REA reverse-engineering tools.",
        localizedDescriptions: { "zh-CN": "包含终端、Codex 和 REA 逆向工程工具的运行环境。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_REA_IMAGE || "huadream/task-handoff-controlled-rea:latest",
        capabilities: ["terminal", "codex", "rea"],
        optionalApps: ["terminal-tty"],
      }),
      embeddedImage({
        id: "market_taskhandoff_opencode",
        slug: "opencode",
        name: "TaskHandoff OpenCode",
        description: "Minimal OpenCode runtime with terminal and OpenCode.",
        localizedDescriptions: { "zh-CN": "最小 OpenCode 运行环境，包含终端和 OpenCode。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_OPENCODE_IMAGE || "huadream/task-handoff-controlled-opencode:latest",
        capabilities: ["terminal", "opencode"],
        optionalApps: ["terminal-tty"],
      }),
      embeddedImage({
        id: "market_taskhandoff_webcap",
        slug: "webcap",
        name: "TaskHandoff WebCap",
        description: "Browser automation runtime with WebCap, Codex, Claude, Chromium, and VNC.",
        localizedDescriptions: { "zh-CN": "浏览器自动化运行环境，包含 WebCap、Codex、Claude、Chromium 和 VNC。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_WEB_CAP_IMAGE || "huadream/task-handoff-controlled-webcap:latest",
        capabilities: ["terminal", "gui-terminal", "browser", "web-cap", "codex", "claude"],
        optionalApps: ["chromium", "terminal-tty", "gui-terminal"],
      }),
      embeddedImage({
        id: "market_taskhandoff_bcap",
        slug: "bcap",
        name: "TaskHandoff BCap",
        description: "Browser automation runtime with BCap, Codex, Claude, Chromium, and VNC.",
        localizedDescriptions: { "zh-CN": "浏览器自动化运行环境，包含 BCap、Codex、Claude、Chromium 和 VNC。" },
        reference: process.env.TASK_HANDOFF_CONTROLLED_BCAP_IMAGE || "huadream/task-handoff-controlled-bcap:latest",
        capabilities: ["terminal", "gui-terminal", "browser", "bcap", "codex", "claude"],
        optionalApps: ["chromium", "terminal-tty", "gui-terminal"],
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
