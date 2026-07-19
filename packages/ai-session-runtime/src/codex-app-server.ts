import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionActionResult, AiSessionApprovalDecision, AiSessionControlProvider, AiSessionSendInput } from "./ai-session-control";
import { aiSessionControlError } from "./ai-session-control";
import type { AiSessionDiscoveryContext, AiSessionDiscoveryProvider } from "./ai-session-discovery";
import type { AiSessionRegistry } from "./ai-session-registry";
import { CodexAppServerClient, type CodexAppServerClientOptions } from "./codex-app-server/client/client";
import type { CodexAppServerClientLike } from "./codex-app-server/client/contract";
import { CodexAppServerConnectionManager } from "./codex-app-server/client/connection-manager";
import type { CodexAppServerEvent, CodexThread, CodexThreadStatus } from "./codex-app-server/protocol/types";
import { CodexAppServerApprovalCoordinator } from "./codex-app-server/session/approval-coordinator";
import { CodexAppServerSessionBinding, type CodexAppSession } from "./codex-app-server/session/binding";
import { CodexAppServerSessionControl } from "./codex-app-server/session/control";
import { CodexAppServerSessionDiscovery } from "./codex-app-server/session/discovery";
import { CodexAppServerSessionProjector } from "./codex-app-server/session/projector";
import { CodexAppServerMentions } from "./codex-app-server/mentions";

export { CodexAppServerClient } from "./codex-app-server/client/client";
type CodexAppServerBridgeOptions = {
  allowSpawn?: boolean;
  createClient?: (options: CodexAppServerClientOptions) => CodexAppServerClientLike;
  onEventSourceClose?: () => void;
  onMessageDelta?: (event: {
    sessionId: string;
    providerSessionId: string;
    turnId: string;
    itemId: string;
    delta: string;
  }) => void;
};

export type { CodexAppServerClientLike } from "./codex-app-server/client/contract";

export class CodexAppServerSessionBridge implements AiSessionControlProvider, AiSessionDiscoveryProvider {
  readonly id = "codex-app-server";
  readonly agent = "codex";
  private readonly binding = new CodexAppServerSessionBinding();
  private readonly connection: CodexAppServerConnectionManager;
  private readonly approvalCoordinator: CodexAppServerApprovalCoordinator;
  private readonly control: CodexAppServerSessionControl;
  private readonly discovery: CodexAppServerSessionDiscovery;
  private readonly projector: CodexAppServerSessionProjector;
  private readonly mentions: CodexAppServerMentions;
  private readonly injectedClient?: CodexAppServerClientLike;
  private readonly options: CodexAppServerBridgeOptions;

  constructor(
    private readonly registry: AiSessionRegistry,
    clientOrOptions: CodexAppServerClientLike | CodexAppServerBridgeOptions = {},
    injectedOptions: CodexAppServerBridgeOptions = {},
  ) {
    if ("start" in clientOrOptions && "listLoadedThreadIds" in clientOrOptions) {
      this.injectedClient = clientOrOptions;
      this.options = { allowSpawn: true, ...injectedOptions };
    } else {
      this.options = clientOrOptions;
    }
    this.connection = new CodexAppServerConnectionManager({
      injectedClient: this.injectedClient,
      createClient: (options) => this.createClient(options),
      onEvent: (event) => this.applyProviderEvent(event),
      onInvalidate: () => {
        this.options.onEventSourceClose?.();
        this.approvalCoordinator?.resetConnection();
        this.projector?.resetConnection();
        this.mentions?.resetConnection();
      },
    });
    this.approvalCoordinator = new CodexAppServerApprovalCoordinator({
      registry,
      currentClient: () => this.connection.client,
      readyClient: () => this.requireReadyClient(),
      findSession: (threadId) => this.registry.getByProviderSessionId("codex", threadId),
      applyThreadSnapshot: (thread) => this.upsertThread(thread, { bindAppSession: true }),
    });
    this.projector = new CodexAppServerSessionProjector({
      registry,
      findSession: (threadId) => this.registry.getByProviderSessionId("codex", threadId),
      clearApprovalSession: (sessionId) => this.approvalCoordinator.clearSession(sessionId),
      attachApprovalLifecycle: (sessionId, lifecycle) => this.approvalCoordinator.attachLifecycle(sessionId, lifecycle),
      latestApprovalSummary: (sessionId) => this.approvalCoordinator.latestForSession(sessionId)?.summary,
      onMessageDelta: (event) => this.options.onMessageDelta?.(event),
    });
    this.mentions = new CodexAppServerMentions({
      readyClient: () => this.requireReadyClient(),
      connectionEpoch: () => this.connection.epoch,
    });
    this.control = new CodexAppServerSessionControl({
      registry,
      readyClient: () => this.requireReadyClient(),
      validateReferences: (session, references) => this.mentions.validateReferences(session, references),
    });
    this.discovery = new CodexAppServerSessionDiscovery({
      applyThreadSnapshot: (thread) => this.upsertThread(thread, { bindAppSession: true }),
      ensureThreadSubscribed: (client, threadId) => {
        const connection = this.connection.connectionFor(client);
        return connection
          ? this.connection.ensureThreadSubscribed(connection, threadId)
          : Promise.resolve(undefined);
      },
    });
  }

  async sync(appSessions: CodexAppSession[] = []) {
    const previousSocketPath = this.binding.socketPath;
    const socketPath = this.binding.update(appSessions);
    if (!this.injectedClient && !socketPath && !this.options.allowSpawn) {
      this.stop();
      return;
    }
    if (!this.injectedClient && (!this.connection.client || previousSocketPath !== socketPath)) {
      this.connection.configure(socketPath);
    } else if (this.injectedClient && !this.connection.client) {
      this.connection.configure();
    }
    if (!this.connection.client) {
      return;
    }
    let ready;
    try {
      ready = await this.connection.ready({ respectRetry: true });
    } catch {
      return;
    }
    if (!ready || !this.connection.isCurrent(ready)) return;
    try {
      await this.discovery.sync(ready.client, () => this.connection.isCurrent(ready));
    } catch {
      this.connection.markUnhealthy(ready);
    }
  }

  async refresh(context: AiSessionDiscoveryContext) {
    await this.sync(context.appSessions);
  }

  stop() {
    this.connection.stop();
    this.binding.clear();
  }

  async sendMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    return this.control.sendMessage(session, input);
  }

  async startMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    return this.control.startMessage(session, input);
  }

  async steerMessage(session: AiSessionStatus, input: AiSessionSendInput): Promise<AiSessionActionResult> {
    return this.control.steerMessage(session, input);
  }

  async interrupt(session: AiSessionStatus): Promise<AiSessionActionResult> {
    return this.control.interrupt(session);
  }

  async resolveApproval(session: AiSessionStatus, decision: AiSessionApprovalDecision): Promise<AiSessionActionResult> {
    return this.approvalCoordinator.resolve(session, decision);
  }

  mentionCatalog(session: AiSessionStatus) {
    return this.mentions.catalog(session);
  }

  searchMentionFiles(session: AiSessionStatus, query: string) {
    return this.mentions.searchFiles(session, query);
  }

  private createClient(options: CodexAppServerClientOptions) {
    return this.options.createClient ? this.options.createClient(options) : new CodexAppServerClient(options);
  }

  private applyProviderEvent(event: CodexAppServerEvent) {
    if (event.type === "thread") {
      this.upsertThread(event.thread, { bindAppSession: true });
      return;
    }
    if (event.type === "approval-request") {
      this.approvalCoordinator.register(event.request);
      return;
    }
    this.projector.apply(event);
  }

  private upsertThread(thread: CodexThread, options: { bindAppSession: boolean }) {
    const id = typeof thread.id === "string" ? thread.id : undefined;
    if (!id || thread.ephemeral === true) {
      return;
    }
    const appSessionId = options.bindAppSession ? this.binding.appSessionIdForThread(id) : undefined;
    this.projector.applyThreadSnapshot(thread, { appSessionId });
  }

  private async requireReadyClient() {
    if (!this.connection.client) {
      throw aiSessionControlError("AI_SESSION_CONTROL_NOT_CONNECTED", "Codex app-server is not connected.", 503);
    }
    try {
      const ready = await this.connection.ready();
      if (ready) return ready.client;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw aiSessionControlError("AI_SESSION_CONTROL_NOT_CONNECTED", error instanceof Error ? error.message : "Codex app-server is not connected.", 503);
    }
    throw aiSessionControlError("AI_SESSION_CONTROL_NOT_CONNECTED", "Codex app-server is not connected.", 503);
  }

}
