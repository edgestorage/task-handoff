import type { AiSessionCommandInput, AiSessionCommandResult, AiSessionStatus } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionActionResult, AiSessionApprovalDecision, AiSessionControlProvider, AiSessionProviderCreateInput, AiSessionProviderCreateResult, AiSessionSendInput } from "./ai-session-control";
import { aiSessionControlError } from "./ai-session-control";
import type { AiSessionDiscoveryContext, AiSessionDiscoveryProvider } from "./ai-session-discovery";
import type { AiSessionRegistry } from "./ai-session-registry";
import { CodexAppServerClient, type CodexAppServerClientOptions } from "./codex-app-server/client/client";
import type { CodexAppServerClientLike } from "./codex-app-server/client/contract";
import type { CodexThreadStartOptions } from "./codex-app-server/client/contract";
import { CodexAppServerConnectionManager } from "./codex-app-server/client/connection-manager";
import type { CodexAppServerEvent, CodexThread, CodexThreadStatus } from "./codex-app-server/protocol/types";
import { CodexAppServerApprovalCoordinator } from "./codex-app-server/session/approval-coordinator";
import { CodexAppServerSessionBinding, type CodexAppSession } from "./codex-app-server/session/binding";
import { CodexAppServerSessionControl } from "./codex-app-server/session/control";
import { codexPermissionOverrides } from "./codex-app-server/session/control";
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
  threadStartDefaults?: Pick<CodexThreadStartOptions, "model" | "modelProvider">;
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
  private directCreateRequests = 0;

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

  async createSession(input: AiSessionProviderCreateInput): Promise<AiSessionProviderCreateResult> {
    const client = await this.requireReadyClient();
    if (!client.startThread) {
      throw aiSessionControlError("AI_SESSION_CREATE_UNSUPPORTED", "Codex app-server does not support thread creation.", 400);
    }
    this.directCreateRequests += 1;
    try {
      const thread = await client.startThread({
        cwd: input.cwd,
        runtimeWorkspaceRoots: [input.cwd],
        ...this.options.threadStartDefaults,
        permissions: codexPermissionOverrides(input.permissionMode),
      });
      this.projector.applyThreadSnapshot(thread, { creationSource: "ai-session" });
      const providerSessionId = typeof thread.id === "string" ? thread.id.trim() : "";
      const cwd = typeof thread.cwd === "string" ? thread.cwd.trim() : "";
      if (!providerSessionId || !cwd) {
        throw aiSessionControlError("AI_SESSION_CREATE_INVALID_RESPONSE", "Codex app-server returned an invalid thread identity.", 502);
      }
      return { providerSessionId, cwd, creationSource: "ai-session" };
    } finally {
      this.directCreateRequests -= 1;
    }
  }

  async readSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    if (!client.readThread) throw aiSessionControlError("AI_SESSION_READ_UNSUPPORTED", "Codex app-server does not support thread reads.", 400);
    const thread = await client.readThread(providerSessionId, { includeTurns: true });
    if (!thread) throw aiSessionControlError("AI_SESSION_THREAD_NOT_FOUND", "Codex thread was not found.", 404);
    this.projector.applyThreadSnapshot(thread, { creationSource: "ai-session" });
  }

  async resumeSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    if (client.unarchiveThread) await client.unarchiveThread(providerSessionId);
    const thread = client.resumeThread
      ? await client.resumeThread(providerSessionId)
      : client.readThread ? await client.readThread(providerSessionId, { includeTurns: true }) : undefined;
    if (!thread) throw aiSessionControlError("AI_SESSION_RESUME_UNSUPPORTED", "Codex app-server could not resume the thread.", 409);
    this.projector.applyThreadSnapshot(thread, { creationSource: "ai-session" });
  }

  async archiveSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    if (!client.archiveThread) throw aiSessionControlError("AI_SESSION_CLOSE_UNSUPPORTED", "Codex app-server does not support thread archive.", 400);
    await client.archiveThread(providerSessionId);
  }

  async deleteSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    if (!client.deleteThread) throw aiSessionControlError("AI_SESSION_DELETE_UNSUPPORTED", "Codex app-server does not support thread deletion.", 400);
    await client.deleteThread(providerSessionId);
  }

  async unsubscribeSession(providerSessionId: string) {
    const client = await this.requireReadyClient();
    await client.unsubscribeThread?.(providerSessionId);
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

  async executeCommand(session: AiSessionStatus, input: AiSessionCommandInput): Promise<AiSessionCommandResult> {
    if (session.agent !== "codex" || !session.providerSessionId) {
      throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Only Codex app-server sessions support commands.", 400);
    }
    if ((input.command === "review" || input.command === "compact") && (session.status === "running" || session.status === "waiting")) {
      throw aiSessionControlError("AI_SESSION_BUSY", `${input.command} is unavailable while the session is busy.`, 409);
    }
    const client = await this.requireReadyClient();
    const threadId = session.providerSessionId;
    if (input.command === "review") {
      if (!client.startReview) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support review.", 409);
      const result = await client.startReview(threadId);
      return { command: input.command, turnId: result.turnId };
    }
    if (input.command === "compact") {
      if (!client.compactThread) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support compaction.", 409);
      await client.compactThread(threadId);
      return { command: input.command };
    }
    if (input.command === "rename") {
      if (!client.setThreadName) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support renaming threads.", 409);
      await client.setThreadName(threadId, input.argument || "");
      return { command: input.command, value: input.argument };
    }
    if (input.argument) {
      if (!client.setThreadGoal) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support goals.", 409);
      await client.setThreadGoal(threadId, input.argument);
      return { command: input.command, value: input.argument };
    }
    if (!client.getThreadGoal) throw aiSessionControlError("AI_SESSION_COMMAND_UNSUPPORTED", "Codex app-server does not support goals.", 409);
    const result = await client.getThreadGoal(threadId);
    const goal = result.goal && typeof result.goal === "object" ? result.goal as Record<string, unknown> : undefined;
    return { command: input.command, value: typeof goal?.objective === "string" ? goal.objective : "No active goal." };
  }

  private createClient(options: CodexAppServerClientOptions) {
    return this.options.createClient ? this.options.createClient(options) : new CodexAppServerClient(options);
  }

  private applyProviderEvent(event: CodexAppServerEvent) {
    if (event.type === "thread") {
      this.upsertThread(event.thread, {
        bindAppSession: true,
        creationSource: this.directCreateRequests > 0 ? "ai-session" : undefined,
      });
      return;
    }
    if (event.type === "approval-request") {
      this.approvalCoordinator.register(event.request);
      return;
    }
    if (event.type === "thread-name") {
      const session = this.registry.getByProviderSessionId("codex", event.threadId);
      if (session) {
        this.registry.applyAdapterSnapshot({
          source: "adapter-snapshot",
          agent: "codex",
          appId: session.appId,
          appSessionId: session.appSessionId,
          providerSessionId: event.threadId,
          title: event.name,
        });
      }
      return;
    }
    this.projector.apply(event);
  }

  private upsertThread(thread: CodexThread, options: { bindAppSession: boolean; creationSource?: AiSessionStatus["creationSource"] }) {
    const id = typeof thread.id === "string" ? thread.id : undefined;
    if (!id || thread.ephemeral === true) {
      return;
    }
    const appSessionId = options.bindAppSession ? this.binding.appSessionIdForThread(id) : undefined;
    this.projector.applyThreadSnapshot(thread, { appSessionId, creationSource: options.creationSource });
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
