import { z } from "zod";
import {
  ControlPlaneAiSessionsSchema,
  ControlPlaneAppSessionsSchema,
  PublicModelRegistryEntrySchema,
  PublicModelRegistrySchema,
  type ControlPlaneClient,
} from "@task-handoff/control-plane-client";
import {
  ControlPlaneInstanceDirectoryEntrySchema,
  ControlPlaneInstanceDirectorySchema,
  ControlPlaneNodeDirectoryEntrySchema,
  ControlPlaneNodeDirectorySchema,
} from "@task-handoff/protocol/control-plane-directory";
import { InstanceCreateResultSchema, InstanceDeleteResultSchema } from "@task-handoff/protocol/control-plane";
import {
  AiSessionActionCompatibleResponseSchema,
  AiSessionCloseResultSchema,
  AiSessionCreateResultSchema,
  AiSessionDetailReadSchema,
  AiSessionForkResultSchema,
  AiSessionHistoryListSchema,
  AiSessionModelSelectionActionResponseSchema,
  AiSessionQueueMutationResponseSchema,
  AiSessionQueueSchema,
  AiSessionReasoningEffortActionResponseSchema,
  AiSessionRenameResultSchema,
  AiSessionResumeResultSchema,
  AiSessionTimelineSchema,
  AiSessionTurnBodyReadSchema,
  AiSessionTurnIndexReadSchema,
  AiSessionTurnTimelineSchema,
  AiSessionUnreadStateSchema,
} from "@task-handoff/protocol/ai-sessions";
import { AppSessionAccessLeaseSchema, AppSessionRecordSchema } from "@task-handoff/protocol/app-sessions";
import {
  ControlPlaneUserDetailSchema,
  ControlPlaneUserSessionSummarySchema,
  ControlPlaneUserSummarySchema,
} from "@task-handoff/protocol/control-plane-access";
import {
  StoryAutomationListSchema,
  StoryAutomationRunsSchema,
  StoryAutomationRunSchema,
  StoryAutomationStatusSchema,
  StorySchema,
} from "@task-handoff/protocol/stories";
import { EventWireEnvelopeSchema } from "@task-handoff/protocol/events";
import {
  ControlPlaneTriggerSchema,
  ControlPlaneTriggersSchema,
  TriggerConfigSchema,
  TriggerDeploymentSchema,
  TriggerRuntimeStateSchema,
} from "@task-handoff/protocol/triggers";
import { CliProfileSchema } from "./config.ts";
import type { CliHandler } from "./runtime.ts";
import {
  aiSessionApproval,
  aiSessionClose,
  aiSessionCreate,
  aiSessionFork,
  aiSessionHistory,
  aiSessionInterrupt,
  aiSessionList,
  aiSessionModel,
  aiSessionQueueEdit,
  aiSessionQueueList,
  aiSessionQueueRemove,
  aiSessionQueueReorder,
  aiSessionQueueRetry,
  aiSessionQueueSteer,
  aiSessionRead,
  aiSessionReasoning,
  aiSessionRename,
  aiSessionResume,
  aiSessionSend,
  aiSessionShow,
  aiSessionTimeline,
  aiSessionTurn,
  aiSessionTurnTimeline,
  aiSessionTurns,
} from "./commands/ai-session.ts";
import { appSessionAccess, appSessionList, appSessionRename, appSessionRestart, appSessionShow, appSessionStart, appSessionStop } from "./commands/app-session.ts";
import { eventsCommand } from "./commands/events.ts";
import { instanceCreate, instanceDelete, instanceList, instanceRename, instanceRestart, instanceShow, instanceStart, instanceStop } from "./commands/instance.ts";
import { modelList, modelShow } from "./commands/model.ts";
import { nodeList, nodeRename, nodeShow } from "./commands/node.ts";
import { profileAdd, profileList, profileRemove, profileShow, profileTrust, profileUse } from "./commands/profile.ts";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/session.ts";
import { schemaCommand } from "./commands/schema.ts";
import {
  storyArchive,
  storyAutomationCreate,
  storyAutomationDisable,
  storyAutomationEnable,
  storyAutomationList,
  storyAutomationRemove,
  storyAutomationRun,
  storyAutomationRuns,
  storyAutomationShow,
  storyAutomationUpdate,
  storyCreate,
  storyDocumentRemove,
  storyDocumentReorder,
  storyDocumentUpdate,
  storyList,
  storyRemove,
  storyRestore,
  storyShow,
  storyUpdate,
} from "./commands/story.ts";
import { triggerApply, triggerBind, triggerCreate, triggerList, triggerRemove, triggerRun, triggerShow, triggerUnbind, triggerUpdate } from "./commands/trigger.ts";
import { userList, userSessionRevoke, userSessions, userShow } from "./commands/user.ts";

export type CliArgument = {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
};

export type CliOption = {
  flags: string;
  description: string;
  repeatable?: boolean;
};

export type CliStage = "A" | "B" | "C";

export type CliLeaf = {
  id: string;
  group: string;
  name: string;
  summary: string;
  stage: CliStage;
  args?: readonly CliArgument[];
  options?: readonly CliOption[];
  /** CLI 参数与选项的输入契约；`thctl schema` 用它导出 JSON Schema。 */
  input: z.ZodType;
  /** 服务端 wire 模型输出契约；`outputPinned` 为 false 表示阶段实现时才收窄。 */
  output: z.ZodType;
  outputPinned?: boolean;
  /** `json-lines` 表示命令持续输出多行 JSON，而非单个文档。 */
  outputMode?: "document" | "json-lines";
  examples?: readonly string[];
  write?: boolean;
  handler?: CliHandler;
};

export type CliGroup = {
  name: string;
  summary: string;
  /** flat 分组直接注册在根命令下（如 `thctl login`），不生成同名父命令。 */
  flat?: boolean;
  leaves: readonly CliLeaf[];
};

const looseOutput = z.looseObject({});
const emptyInput = z.object({}).strict();

function inputOf(properties: Record<string, z.ZodType>) {
  return z.object(properties).strict();
}

function group(name: string, summary: string, leaves: readonly CliLeaf[], options: { flat?: boolean } = {}): CliGroup {
  return { name, summary, leaves, ...(options.flat ? { flat: true } : {}) };
}

export function leafId(group: string, name: string) {
  return `${group} ${name}`;
}

const profileAddInput = inputOf({ origin: z.string(), label: z.string().optional() });
const profileLabelInput = inputOf({ label: z.string() });

const profileGroup = group("profile", "Manage Control Plane profiles", [
  {
    id: "profile add", group: "profile", name: "add", stage: "A",
    summary: "Add a Control Plane profile and pin its identity fingerprint",
    args: [{ name: "origin", description: "Control Plane origin, for example https://control.example.com", required: true }],
    options: [{ flags: "--label <label>", description: "Profile label (defaults to the host name)" }],
    input: profileAddInput,
    output: CliProfileSchema,
    examples: ["thctl profile add https://control.example.com", "thctl profile add http://127.0.0.1:8787 --label local"],
    handler: profileAdd,
  },
  {
    id: "profile list", group: "profile", name: "list", stage: "A",
    summary: "List configured Control Plane profiles",
    input: emptyInput,
    output: z.array(CliProfileSchema.extend({ default: z.boolean() })),
    handler: profileList,
  },
  {
    id: "profile use", group: "profile", name: "use", stage: "A",
    summary: "Set the default profile",
    args: [{ name: "label", description: "Profile label", required: true }],
    input: profileLabelInput,
    output: z.object({ defaultProfile: z.string() }),
    handler: profileUse,
  },
  {
    id: "profile show", group: "profile", name: "show", stage: "A",
    summary: "Show one profile, its pinned identity and local sign-in state",
    args: [{ name: "label", description: "Profile label (defaults to the selected profile)" }],
    input: inputOf({ label: z.string().optional() }),
    output: CliProfileSchema.extend({ signedIn: z.boolean(), sessionExpiresAt: z.string().optional() }),
    handler: profileShow,
  },
  {
    id: "profile remove", group: "profile", name: "remove", stage: "A", write: true,
    summary: "Remove a profile and its local credentials",
    args: [{ name: "label", description: "Profile label", required: true }],
    input: profileLabelInput,
    output: z.object({ label: z.string(), removed: z.boolean() }),
    handler: profileRemove,
  },
  {
    id: "profile trust", group: "profile", name: "trust", stage: "A", write: true,
    summary: "Re-pin the identity fingerprint of an existing profile after verifying it",
    args: [{ name: "label", description: "Profile label", required: true }],
    input: profileLabelInput,
    output: CliProfileSchema,
    handler: profileTrust,
  },
]);

const sessionGroup = group("auth", "Authenticate the CLI against a Control Plane", [
  {
    id: "login", group: "auth", name: "login", stage: "A",
    summary: "Authorize this CLI through the Control Plane web login",
    options: [{ flags: "--device", description: "Use the device authorization flow for machines without a browser" }],
    input: inputOf({ device: z.boolean().optional() }),
    output: z.object({ profile: z.string(), sessionId: z.string(), expiresAt: z.string(), loginMode: z.enum(["browser", "device"]) }),
    examples: ["thctl login", "thctl login --device --profile prod"],
    handler: loginCommand,
  },
  {
    id: "logout", group: "auth", name: "logout", stage: "A",
    summary: "Revoke the stored CLI session on the server and locally",
    input: emptyInput,
    output: z.object({ profile: z.string(), revoked: z.boolean() }),
    handler: logoutCommand,
  },
  {
    id: "whoami", group: "auth", name: "whoami", stage: "A",
    summary: "Show the signed-in user, profile and pinned Control Plane identity",
    input: emptyInput,
    output: z.looseObject({}),
    handler: whoamiCommand,
  },
], { flat: true });

const instanceIdArg: CliArgument = { name: "instanceId", description: "Controlled instance ID", required: true };

const instanceGroup = group("instance", "Inspect and control instances", [
  {
    id: "instance list", group: "instance", name: "list", stage: "A",
    summary: "List controlled instances from the authoritative directory projection",
    options: [{ flags: "--node <nodeId>", description: "Only instances on this node" }],
    input: inputOf({ node: z.string().optional() }),
    output: ControlPlaneInstanceDirectorySchema,
    handler: instanceList,
  },
  {
    id: "instance show", group: "instance", name: "show", stage: "A",
    summary: "Show one controlled instance from the authoritative directory projection",
    args: [instanceIdArg],
    input: inputOf({ instanceId: z.string() }),
    output: ControlPlaneInstanceDirectoryEntrySchema,
    handler: instanceShow,
  },
  {
    id: "instance create", group: "instance", name: "create", stage: "B", write: true,
    summary: "Create a controlled instance from a JSON request body",
    options: [
      { flags: "--config <file>", description: "Instance create request JSON (Control Plane wire body)" },
      { flags: "--name <name>", description: "Override the instance display name" },
      { flags: "--node <nodeId>", description: "Override the target node" },
      { flags: "--start", description: "Set start: true (server default is false)" },
    ],
    input: inputOf({ config: z.string(), name: z.string().optional(), node: z.string().optional(), start: z.boolean().optional() }),
    output: InstanceCreateResultSchema,
    examples: [
      "thctl instance create --config ./instance.json --start",
      "thctl instance create --config ./instance.json --name demo --node node_x --dry-run",
    ],
    handler: instanceCreate,
  },
  {
    id: "instance delete", group: "instance", name: "delete", stage: "B", write: true,
    summary: "Delete a controlled instance, optionally deleting its volumes",
    args: [instanceIdArg],
    options: [{ flags: "--volumes", description: "Also delete the instance's managed volumes (irreversible)" }],
    input: inputOf({ instanceId: z.string(), volumes: z.boolean().optional() }),
    output: InstanceDeleteResultSchema,
    examples: ["thctl instance delete <instanceId> --yes", "thctl instance delete <instanceId> --volumes --yes"],
    handler: instanceDelete,
  },
  {
    id: "instance start", group: "instance", name: "start", stage: "A", write: true,
    summary: "Start a controlled instance",
    args: [instanceIdArg],
    input: inputOf({ instanceId: z.string() }),
    output: z.object({ id: z.string(), status: z.string() }),
    handler: instanceStart,
  },
  {
    id: "instance stop", group: "instance", name: "stop", stage: "A", write: true,
    summary: "Stop a controlled instance",
    args: [instanceIdArg],
    input: inputOf({ instanceId: z.string() }),
    output: z.object({ id: z.string(), status: z.string() }),
    handler: instanceStop,
  },
  {
    id: "instance restart", group: "instance", name: "restart", stage: "A", write: true,
    summary: "Restart a controlled instance",
    args: [instanceIdArg],
    input: inputOf({ instanceId: z.string() }),
    output: z.object({ id: z.string(), status: z.string() }),
    handler: instanceRestart,
  },
  {
    id: "instance logs", group: "instance", name: "logs", stage: "C",
    summary: "Stream instance logs (planned with the events stream work)",
    args: [instanceIdArg],
    options: [{ flags: "--follow", description: "Keep streaming new log lines" }],
    input: inputOf({ instanceId: z.string(), follow: z.boolean().optional() }),
    output: looseOutput, outputPinned: false,
  },
  {
    id: "instance rename", group: "instance", name: "rename", stage: "B", write: true,
    summary: "Rename a controlled instance",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "name", description: "New display name", required: true },
    ],
    input: inputOf({ instanceId: z.string(), name: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
    handler: instanceRename,
  },
]);

const aiSessionGroup = group("ai-session", "Inspect and drive AI sessions", [
  {
    id: "ai-session list", group: "ai-session", name: "list", stage: "A",
    summary: "List AI sessions across visible instances",
    options: [{ flags: "--instance <instanceId>", description: "Only sessions of this instance" }],
    input: inputOf({ instance: z.string().optional() }),
    output: ControlPlaneAiSessionsSchema,
    handler: aiSessionList,
  },
  {
    id: "ai-session show", group: "ai-session", name: "show", stage: "A",
    summary: "Show one AI session projection",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string() }),
    output: AiSessionDetailReadSchema,
    handler: aiSessionShow,
  },
  {
    id: "ai-session history", group: "ai-session", name: "history", stage: "B",
    summary: "List provider session history for an instance",
    args: [{ name: "instanceId", description: "Controlled instance ID", required: true }],
    options: [{ flags: "--agent <agent>", description: "Restrict to one agent", repeatable: true }],
    input: inputOf({ instanceId: z.string(), agent: z.array(z.string()).optional() }),
    output: AiSessionHistoryListSchema,
    handler: aiSessionHistory,
  },
  {
    id: "ai-session turns", group: "ai-session", name: "turns", stage: "B",
    summary: "List turn index entries of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [{ flags: "--revision <revision>", description: "Return not-modified when this revision already matches" }],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), revision: z.string().optional() }),
    output: AiSessionTurnIndexReadSchema,
    handler: aiSessionTurns,
  },
  {
    id: "ai-session turn", group: "ai-session", name: "turn", stage: "B",
    summary: "Show one turn body of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "turnId", description: "Turn ID", required: true },
    ],
    options: [{ flags: "--revision <revision>", description: "Return not-modified when this revision already matches" }],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), turnId: z.string(), revision: z.string().optional() }),
    output: AiSessionTurnBodyReadSchema,
    handler: aiSessionTurn,
  },
  {
    id: "ai-session timeline", group: "ai-session", name: "timeline", stage: "B",
    summary: "Show the conversation timeline of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string() }),
    output: AiSessionTimelineSchema,
    handler: aiSessionTimeline,
  },
  {
    id: "ai-session turn-timeline", group: "ai-session", name: "turn-timeline", stage: "B",
    summary: "Show the timeline of one AI session turn",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "turnId", description: "Turn ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), turnId: z.string() }),
    output: AiSessionTurnTimelineSchema,
    handler: aiSessionTurnTimeline,
  },
  {
    id: "ai-session create", group: "ai-session", name: "create", stage: "B", write: true,
    summary: "Create an AI session on an instance",
    args: [{ name: "instanceId", description: "Controlled instance ID", required: true }],
    options: [
      { flags: "--prompt <text>", description: "Initial prompt" },
      { flags: "--agent <agent>", description: "Agent kind (codex, claude, opencode)" },
      { flags: "--cwd-folder <cwdFolderId>", description: "Instance folder to run in" },
      { flags: "--story <storyId>", description: "Story to attach the session to" },
      { flags: "--request-id <id>", description: "Client request ID for retry-safe creation" },
    ],
    input: inputOf({ instanceId: z.string(), prompt: z.string(), agent: z.string(), cwdFolder: z.string().optional(), story: z.string().optional(), requestId: z.string().optional() }),
    output: AiSessionCreateResultSchema,
    handler: aiSessionCreate,
  },
  {
    id: "ai-session send", group: "ai-session", name: "send", stage: "B", write: true,
    summary: "Send a message to an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "message", description: "Message text", required: true },
    ],
    options: [{ flags: "--mode <auto|queue|steer|immediate>", description: "Delivery mode" }],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), message: z.string(), mode: z.string().optional() }),
    output: AiSessionActionCompatibleResponseSchema,
    handler: aiSessionSend,
  },
  {
    id: "ai-session interrupt", group: "ai-session", name: "interrupt", stage: "B", write: true,
    summary: "Interrupt the active turn of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string() }),
    output: AiSessionActionCompatibleResponseSchema,
    handler: aiSessionInterrupt,
  },
  {
    id: "ai-session approval", group: "ai-session", name: "approval", stage: "B", write: true,
    summary: "Answer a pending approval request of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [{ flags: "--decision <allow|deny|skip>", description: "Approval decision" }],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), decision: z.enum(["allow", "deny", "skip"]) }),
    output: AiSessionActionCompatibleResponseSchema,
    handler: aiSessionApproval,
  },
  {
    id: "ai-session resume", group: "ai-session", name: "resume", stage: "B", write: true,
    summary: "Resume a suspended AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string() }),
    output: AiSessionResumeResultSchema,
    handler: aiSessionResume,
  },
  {
    id: "ai-session read", group: "ai-session", name: "read", stage: "B", write: true,
    summary: "Mark an AI session as read",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string() }),
    output: AiSessionUnreadStateSchema,
    handler: aiSessionRead,
  },
  {
    id: "ai-session rename", group: "ai-session", name: "rename", stage: "B", write: true,
    summary: "Rename an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [
      { flags: "--title <title>", description: "New session title" },
      { flags: "--request-id <id>", description: "Client request ID for retry-safe rename" },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), title: z.string(), requestId: z.string().optional() }),
    output: AiSessionRenameResultSchema,
    handler: aiSessionRename,
  },
  {
    id: "ai-session fork", group: "ai-session", name: "fork", stage: "B", write: true,
    summary: "Fork an AI session into a new session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [
      { flags: "--through-turn <turnId>", description: "Fork after this turn" },
      { flags: "--workspace <current|managed-worktree>", description: "Workspace mode for the fork" },
      { flags: "--request-id <id>", description: "Client request ID for retry-safe fork" },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), throughTurn: z.string().optional(), workspace: z.string().optional(), requestId: z.string().optional() }),
    output: AiSessionForkResultSchema,
    handler: aiSessionFork,
  },
  {
    id: "ai-session close", group: "ai-session", name: "close", stage: "B", write: true,
    summary: "Close an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [{ flags: "--request-id <id>", description: "Client request ID for retry-safe close" }],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), requestId: z.string().optional() }),
    output: AiSessionCloseResultSchema,
    handler: aiSessionClose,
  },
  {
    id: "ai-session model", group: "ai-session", name: "model", stage: "B", write: true,
    summary: "Switch the model of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [
      { flags: "--entity <modelEntityId>", description: "Model entity ID" },
      { flags: "--name <modelName>", description: "Model name within the entity" },
      { flags: "--request-id <id>", description: "Client request ID for retry-safe switching" },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), entity: z.string(), name: z.string(), requestId: z.string().optional() }),
    output: AiSessionModelSelectionActionResponseSchema,
    handler: aiSessionModel,
  },
  {
    id: "ai-session reasoning", group: "ai-session", name: "reasoning", stage: "B", write: true,
    summary: "Set the reasoning effort of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [
      { flags: "--effort <none|minimal|low|medium|high|xhigh|max|ultra>", description: "Reasoning effort" },
      { flags: "--request-id <id>", description: "Client request ID for retry-safe updates" },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), effort: z.string(), requestId: z.string().optional() }),
    output: AiSessionReasoningEffortActionResponseSchema,
    handler: aiSessionReasoning,
  },
  {
    id: "ai-session queue list", group: "ai-session", name: "queue list", stage: "B",
    summary: "List queued messages of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string() }),
    output: AiSessionQueueSchema,
    handler: aiSessionQueueList,
  },
  {
    id: "ai-session queue steer", group: "ai-session", name: "queue steer", stage: "B", write: true,
    summary: "Steer a queued message into the active turn",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "queueId", description: "Queued message ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), queueId: z.string() }),
    output: AiSessionActionCompatibleResponseSchema,
    handler: aiSessionQueueSteer,
  },
  {
    id: "ai-session queue retry", group: "ai-session", name: "queue retry", stage: "B", write: true,
    summary: "Retry a failed queued message",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "queueId", description: "Queued message ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), queueId: z.string() }),
    output: AiSessionQueueMutationResponseSchema,
    handler: aiSessionQueueRetry,
  },
  {
    id: "ai-session queue remove", group: "ai-session", name: "queue remove", stage: "B", write: true,
    summary: "Remove a queued message",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "queueId", description: "Queued message ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), queueId: z.string() }),
    output: AiSessionQueueMutationResponseSchema,
    handler: aiSessionQueueRemove,
  },
  {
    id: "ai-session queue edit", group: "ai-session", name: "queue edit", stage: "B", write: true,
    summary: "Edit a queued message of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "queueId", description: "Queued message ID", required: true },
    ],
    options: [
      { flags: "--message <text>", description: "Replacement message text" },
      { flags: "--expected-revision <revision>", description: "Queue revision for optimistic concurrency (defaults to the current queue)" },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), queueId: z.string(), message: z.string(), expectedRevision: z.string().optional() }),
    output: AiSessionQueueMutationResponseSchema,
    handler: aiSessionQueueEdit,
  },
  {
    id: "ai-session queue reorder", group: "ai-session", name: "queue reorder", stage: "B", write: true,
    summary: "Reorder queued messages of an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [
      { flags: "--queue <queueId>", description: "Queued message ID in the new order", repeatable: true },
      { flags: "--expected-revision <revision>", description: "Queue revision for optimistic concurrency (defaults to the current queue)" },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), queue: z.array(z.string()).optional(), expectedRevision: z.string().optional() }),
    output: AiSessionQueueMutationResponseSchema,
    handler: aiSessionQueueReorder,
  },
]);

const appSessionGroup = group("app-session", "Inspect and control app sessions", [
  {
    id: "app-session list", group: "app-session", name: "list", stage: "B",
    summary: "List app sessions across visible instances",
    options: [{ flags: "--instance <instanceId>", description: "Only sessions of this instance" }],
    input: inputOf({ instance: z.string().optional() }),
    output: ControlPlaneAppSessionsSchema,
    handler: appSessionList,
  },
  {
    id: "app-session show", group: "app-session", name: "show", stage: "B",
    summary: "Show one app session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "appSessionId", description: "App session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), appSessionId: z.string() }),
    output: AppSessionRecordSchema,
    handler: appSessionShow,
  },
  {
    id: "app-session start", group: "app-session", name: "start", stage: "B", write: true,
    summary: "Start an app session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "appId", description: "App ID", required: true },
    ],
    options: [{ flags: "--cwd-folder <cwdFolderId>", description: "Instance folder to launch in" }],
    input: inputOf({ instanceId: z.string(), appId: z.string(), cwdFolder: z.string().optional() }),
    output: AppSessionRecordSchema,
    handler: appSessionStart,
  },
  {
    id: "app-session stop", group: "app-session", name: "stop", stage: "B", write: true,
    summary: "Stop an app session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "appSessionId", description: "App session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), appSessionId: z.string() }),
    output: AppSessionRecordSchema,
    handler: appSessionStop,
  },
  {
    id: "app-session rename", group: "app-session", name: "rename", stage: "B", write: true,
    summary: "Rename an app session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "appSessionId", description: "App session ID", required: true },
      { name: "title", description: "New session title", required: true },
    ],
    input: inputOf({ instanceId: z.string(), appSessionId: z.string(), title: z.string() }),
    output: AppSessionRecordSchema,
    handler: appSessionRename,
  },
  {
    id: "app-session access", group: "app-session", name: "access", stage: "B", write: true,
    summary: "Create a terminal or VNC access lease for an app session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "appSessionId", description: "App session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), appSessionId: z.string() }),
    output: AppSessionAccessLeaseSchema,
    handler: appSessionAccess,
  },
  {
    id: "app-session restart", group: "app-session", name: "restart", stage: "B", write: true,
    summary: "Restart an app session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "appSessionId", description: "App session ID", required: true },
    ],
    input: inputOf({ instanceId: z.string(), appSessionId: z.string() }),
    output: AppSessionRecordSchema,
    handler: appSessionRestart,
  },
]);

const nodeGroup = group("node", "Inspect nodes", [
  {
    id: "node list", group: "node", name: "list", stage: "B",
    summary: "List nodes in the fleet directory",
    input: emptyInput,
    output: ControlPlaneNodeDirectorySchema,
    handler: nodeList,
  },
  {
    id: "node show", group: "node", name: "show", stage: "B",
    summary: "Show one node from the fleet directory",
    args: [{ name: "nodeId", description: "Node ID", required: true }],
    input: inputOf({ nodeId: z.string() }),
    output: ControlPlaneNodeDirectoryEntrySchema,
    handler: nodeShow,
  },
  {
    id: "node rename", group: "node", name: "rename", stage: "B", write: true,
    summary: "Rename a node",
    args: [
      { name: "nodeId", description: "Node ID", required: true },
      { name: "name", description: "New display name", required: true },
    ],
    input: inputOf({ nodeId: z.string(), name: z.string() }),
    output: z.object({ id: z.string(), name: z.string() }),
    handler: nodeRename,
  },
]);

const storyNodeOption = { flags: "--node <nodeId>", description: "Node that owns the story (resolved from the directory when omitted)" };
const storyAutomationArgs: CliArgument[] = [
  { name: "storyId", description: "Story ID", required: true },
  { name: "automationId", description: "Automation ID", required: true },
];
const storyAutomationInput = inputOf({ storyId: z.string(), automationId: z.string(), node: z.string().optional() });
const storyAutomationConfigOption = { flags: "--config <file>", description: "Story automation JSON file" };
const storyAutomationCreateInput = inputOf({ storyId: z.string(), node: z.string().optional(), config: z.string() });
const storyAutomationUpdateInput = inputOf({ storyId: z.string(), automationId: z.string(), node: z.string().optional(), config: z.string() });

const storyGroup = group("story", "Work with stories, documents and automations", [
  {
    id: "story list", group: "story", name: "list", stage: "B",
    summary: "List stories across visible nodes",
    input: emptyInput,
    output: z.object({ stories: z.array(StorySchema), unavailableNodeIds: z.array(z.string()) }),
    handler: storyList,
  },
  {
    id: "story show", group: "story", name: "show", stage: "B",
    summary: "Show one story",
    args: [{ name: "storyId", description: "Story ID", required: true }],
    options: [storyNodeOption],
    input: inputOf({ storyId: z.string(), node: z.string().optional() }),
    output: StorySchema,
    handler: storyShow,
  },
  {
    id: "story create", group: "story", name: "create", stage: "B", write: true,
    summary: "Create a story",
    args: [{ name: "title", description: "Story title", required: true }],
    options: [
      storyNodeOption,
      { flags: "--description <description>", description: "Story description" },
      { flags: "--max-idle-ai-sessions <count>", description: "Idle AI session retention limit" },
    ],
    input: inputOf({ title: z.string(), node: z.string().optional(), description: z.string().optional(), maxIdleAiSessions: z.number().int().nonnegative().optional() }),
    output: StorySchema,
    handler: storyCreate,
  },
  {
    id: "story update", group: "story", name: "update", stage: "B", write: true,
    summary: "Update story metadata",
    args: [{ name: "storyId", description: "Story ID", required: true }],
    options: [
      storyNodeOption,
      { flags: "--title <title>", description: "New title" },
      { flags: "--description <description>", description: "New description" },
      { flags: "--max-idle-ai-sessions <count>", description: "Idle AI session retention limit" },
    ],
    input: inputOf({ storyId: z.string(), node: z.string().optional(), title: z.string().optional(), description: z.string().optional(), maxIdleAiSessions: z.number().int().nonnegative().optional() }),
    output: StorySchema,
    handler: storyUpdate,
  },
  {
    id: "story archive", group: "story", name: "archive", stage: "B", write: true,
    summary: "Archive a story",
    args: [{ name: "storyId", description: "Story ID", required: true }],
    options: [storyNodeOption],
    input: inputOf({ storyId: z.string(), node: z.string().optional() }),
    output: StorySchema,
    handler: storyArchive,
  },
  {
    id: "story restore", group: "story", name: "restore", stage: "B", write: true,
    summary: "Restore an archived story",
    args: [{ name: "storyId", description: "Story ID", required: true }],
    options: [storyNodeOption],
    input: inputOf({ storyId: z.string(), node: z.string().optional() }),
    output: StorySchema,
    handler: storyRestore,
  },
  {
    id: "story remove", group: "story", name: "remove", stage: "B", write: true,
    summary: "Remove a story",
    args: [{ name: "storyId", description: "Story ID", required: true }],
    options: [storyNodeOption],
    input: inputOf({ storyId: z.string(), node: z.string().optional() }),
    output: z.object({ deleted: z.boolean() }),
    handler: storyRemove,
  },
  {
    id: "story document update", group: "story", name: "document update", stage: "B", write: true,
    summary: "Update story document metadata",
    args: [
      { name: "storyId", description: "Story ID", required: true },
      { name: "path", description: "Document path inside the story", required: true },
    ],
    options: [
      storyNodeOption,
      { flags: "--title <title>", description: "New document title" },
      { flags: "--new-path <path>", description: "Move the document to this story path" },
    ],
    input: inputOf({ storyId: z.string(), path: z.string(), node: z.string().optional(), title: z.string().optional(), newPath: z.string().optional() }),
    output: StorySchema,
    handler: storyDocumentUpdate,
  },
  {
    id: "story document remove", group: "story", name: "document remove", stage: "B", write: true,
    summary: "Remove a story document",
    args: [
      { name: "storyId", description: "Story ID", required: true },
      { name: "path", description: "Document path inside the story", required: true },
    ],
    options: [storyNodeOption],
    input: inputOf({ storyId: z.string(), path: z.string(), node: z.string().optional() }),
    output: z.object({ deleted: z.boolean() }),
    handler: storyDocumentRemove,
  },
  {
    id: "story document reorder", group: "story", name: "document reorder", stage: "B", write: true,
    summary: "Reorder story documents",
    args: [
      { name: "storyId", description: "Story ID", required: true },
      { name: "path", description: "Document paths in the new order", required: true, variadic: true },
    ],
    options: [storyNodeOption],
    input: inputOf({ storyId: z.string(), path: z.array(z.string()), node: z.string().optional() }),
    output: StorySchema,
    handler: storyDocumentReorder,
  },
  {
    id: "story automation list", group: "story", name: "automation list", stage: "B",
    summary: "List story automations",
    args: [{ name: "storyId", description: "Story ID", required: true }],
    options: [storyNodeOption],
    input: inputOf({ storyId: z.string(), node: z.string().optional() }),
    output: StoryAutomationListSchema,
    handler: storyAutomationList,
  },
  {
    id: "story automation show", group: "story", name: "automation show", stage: "B",
    summary: "Show one story automation",
    args: storyAutomationArgs,
    options: [storyNodeOption],
    input: storyAutomationInput,
    output: StoryAutomationStatusSchema,
    handler: storyAutomationShow,
  },
  {
    id: "story automation create", group: "story", name: "automation create", stage: "B", write: true,
    summary: "Create a story automation from a JSON config file",
    args: [{ name: "storyId", description: "Story ID", required: true }],
    options: [storyNodeOption, storyAutomationConfigOption],
    input: storyAutomationCreateInput,
    output: StoryAutomationStatusSchema,
    handler: storyAutomationCreate,
  },
  {
    id: "story automation update", group: "story", name: "automation update", stage: "B", write: true,
    summary: "Update a story automation from a JSON config file",
    args: storyAutomationArgs,
    options: [storyNodeOption, storyAutomationConfigOption],
    input: storyAutomationUpdateInput,
    output: StoryAutomationStatusSchema,
    handler: storyAutomationUpdate,
  },
  {
    id: "story automation remove", group: "story", name: "automation remove", stage: "B", write: true,
    summary: "Remove a story automation",
    args: storyAutomationArgs,
    options: [storyNodeOption],
    input: storyAutomationInput,
    output: z.object({ deleted: z.boolean() }),
    handler: storyAutomationRemove,
  },
  {
    id: "story automation enable", group: "story", name: "automation enable", stage: "B", write: true,
    summary: "Enable a story automation",
    args: storyAutomationArgs,
    options: [storyNodeOption],
    input: storyAutomationInput,
    output: StoryAutomationStatusSchema,
    handler: storyAutomationEnable,
  },
  {
    id: "story automation disable", group: "story", name: "automation disable", stage: "B", write: true,
    summary: "Disable a story automation",
    args: storyAutomationArgs,
    options: [storyNodeOption],
    input: storyAutomationInput,
    output: StoryAutomationStatusSchema,
    handler: storyAutomationDisable,
  },
  {
    id: "story automation run", group: "story", name: "automation run", stage: "B", write: true,
    summary: "Run a story automation now",
    args: storyAutomationArgs,
    options: [
      storyNodeOption,
      { flags: "--request-id <id>", description: "Client request ID for retry-safe runs" },
    ],
    input: inputOf({ storyId: z.string(), automationId: z.string(), node: z.string().optional(), requestId: z.string().optional() }),
    output: StoryAutomationRunSchema,
    handler: storyAutomationRun,
  },
  {
    id: "story automation runs", group: "story", name: "automation runs", stage: "B",
    summary: "List recent automation runs",
    args: storyAutomationArgs,
    options: [storyNodeOption],
    input: storyAutomationInput,
    output: StoryAutomationRunsSchema,
    handler: storyAutomationRuns,
  },
]);

const triggerGroup = group("trigger", "Inspect and run instance triggers", [
  {
    id: "trigger list", group: "trigger", name: "list", stage: "B",
    summary: "List triggers from the control plane registry",
    options: [{ flags: "--instance <instanceId>", description: "Only triggers deployed to this instance" }],
    input: inputOf({ instance: z.string().optional() }),
    output: ControlPlaneTriggersSchema,
    handler: triggerList,
  },
  {
    id: "trigger show", group: "trigger", name: "show", stage: "B",
    summary: "Show one trigger and its deployments",
    args: [{ name: "configHash", description: "Trigger config hash", required: true }],
    options: [{ flags: "--instance <instanceId>", description: "Only deployments on this instance" }],
    input: inputOf({ configHash: z.string(), instance: z.string().optional() }),
    output: ControlPlaneTriggerSchema,
    handler: triggerShow,
  },
  {
    id: "trigger create", group: "trigger", name: "create", stage: "B", write: true,
    summary: "Create a trigger template and bind it to an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
    ],
    options: [{ flags: "--config <file>", description: "Trigger template JSON file" }],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), config: z.string() }),
    output: z.looseObject({ trigger: z.looseObject({ configHash: z.string() }), binding: z.unknown() }),
    handler: triggerCreate,
  },
  {
    id: "trigger update", group: "trigger", name: "update", stage: "B", write: true,
    summary: "Update a trigger template and fan out to its deployments",
    args: [{ name: "configHash", description: "Trigger config hash", required: true }],
    options: [{ flags: "--config <file>", description: "Trigger template JSON file" }],
    input: inputOf({ configHash: z.string(), config: z.string() }),
    output: z.looseObject({}),
    handler: triggerUpdate,
  },
  {
    id: "trigger remove", group: "trigger", name: "remove", stage: "B", write: true,
    summary: "Remove a trigger template and its deployments",
    args: [{ name: "configHash", description: "Trigger config hash", required: true }],
    input: inputOf({ configHash: z.string() }),
    output: z.looseObject({}),
    handler: triggerRemove,
  },
  {
    id: "trigger run", group: "trigger", name: "run", stage: "B", write: true,
    summary: "Run a trigger on an instance now",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "configHash", description: "Trigger config hash", required: true },
    ],
    options: [{ flags: "--deployment <deploymentId>", description: "Specific deployment to run" }],
    input: inputOf({ instanceId: z.string(), configHash: z.string(), deployment: z.string().optional() }),
    output: z.unknown(),
    handler: triggerRun,
  },
  {
    id: "trigger bind", group: "trigger", name: "bind", stage: "B", write: true,
    summary: "Bind a trigger template to an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "configHash", description: "Trigger config hash", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), configHash: z.string() }),
    output: z.object({ config: TriggerConfigSchema, deployment: TriggerDeploymentSchema, runtime: TriggerRuntimeStateSchema.optional() }),
    handler: triggerBind,
  },
  {
    id: "trigger unbind", group: "trigger", name: "unbind", stage: "B", write: true,
    summary: "Unbind a trigger template from an AI session",
    args: [
      { name: "instanceId", description: "Controlled instance ID", required: true },
      { name: "sessionId", description: "AI session ID", required: true },
      { name: "configHash", description: "Trigger config hash", required: true },
    ],
    input: inputOf({ instanceId: z.string(), sessionId: z.string(), configHash: z.string() }),
    output: z.unknown(),
    handler: triggerUnbind,
  },
  {
    id: "trigger apply", group: "trigger", name: "apply", stage: "B", write: true,
    summary: "Apply a trigger template to instances targeting an AI session",
    args: [{ name: "configHash", description: "Trigger config hash", required: true }],
    options: [
      { flags: "--instance <instanceId>", description: "Instance to deploy to (repeatable)", repeatable: true },
      { flags: "--session <sessionId>", description: "Target AI session ID" },
      { flags: "--disabled", description: "Create the deployment disabled" },
    ],
    input: inputOf({ configHash: z.string(), instance: z.array(z.string()).min(1), session: z.string(), disabled: z.boolean().optional() }),
    output: z.looseObject({ configHash: z.string(), results: z.array(z.unknown()) }),
    handler: triggerApply,
  },
]);

const modelGroup = group("model", "Inspect the model registry", [
  {
    id: "model list", group: "model", name: "list", stage: "B",
    summary: "List models in the public registry",
    input: emptyInput,
    output: PublicModelRegistrySchema,
    handler: modelList,
  },
  {
    id: "model show", group: "model", name: "show", stage: "B",
    summary: "Show one model",
    args: [{ name: "modelId", description: "Model entity ID", required: true }],
    input: inputOf({ modelId: z.string() }),
    output: PublicModelRegistryEntrySchema,
    handler: modelShow,
  },
]);

const userGroup = group("user", "Inspect users and their sessions", [
  {
    id: "user list", group: "user", name: "list", stage: "B",
    summary: "List Control Plane users",
    options: [{ flags: "--include-archived", description: "Include archived users" }],
    input: inputOf({ includeArchived: z.boolean().optional() }),
    output: z.array(ControlPlaneUserSummarySchema),
    handler: userList,
  },
  {
    id: "user show", group: "user", name: "show", stage: "B",
    summary: "Show one user",
    args: [{ name: "userId", description: "User ID", required: true }],
    input: inputOf({ userId: z.string() }),
    output: ControlPlaneUserDetailSchema,
    handler: userShow,
  },
  {
    id: "user sessions", group: "user", name: "sessions", stage: "B",
    summary: "List sessions of a user",
    args: [{ name: "userId", description: "User ID", required: true }],
    input: inputOf({ userId: z.string() }),
    output: z.array(ControlPlaneUserSessionSummarySchema),
    handler: userSessions,
  },
  {
    id: "user session-revoke", group: "user", name: "session-revoke", stage: "B", write: true,
    summary: "Revoke one session of a user",
    args: [
      { name: "userId", description: "User ID", required: true },
      { name: "sessionId", description: "Session ID", required: true },
    ],
    input: inputOf({ userId: z.string(), sessionId: z.string() }),
    output: z.object({ revoked: z.boolean() }),
    handler: userSessionRevoke,
  },
]);
const eventsGroup = group("events", "Stream Control Plane events", [
  {
    id: "events", group: "events", name: "events", stage: "C",
    summary: "Subscribe to the Control Plane event stream as JSON Lines",
    options: [
      { flags: "--topic <topic>", description: "Event topic to subscribe to", repeatable: true },
      { flags: "--instance <instanceId>", description: "Only events of this instance" },
    ],
    input: inputOf({ topic: z.array(z.string()).optional(), instance: z.string().optional() }),
    output: EventWireEnvelopeSchema,
    outputMode: "json-lines",
    examples: ["thctl events", "thctl events --topic ai.sessions --instance <instanceId>", "thctl events --json"],
    handler: eventsCommand,
  },
], { flat: true });

const schemaGroup = group("schema", "Export the machine-readable CLI contract", [
  {
    id: "schema", group: "schema", name: "schema", stage: "A",
    summary: "Export the declared leaf command contracts as JSON Schema or Markdown",
    args: [
      { name: "group", description: "Command group" },
      { name: "leaf", description: "Leaf command name inside the group" },
    ],
    options: [
      { flags: "--format <json|md>", description: "Output format (default json)" },
      { flags: "--out <file>", description: "Write the export to a file" },
    ],
    input: inputOf({ group: z.string().optional(), leaf: z.string().optional(), format: z.enum(["json", "md"]).optional(), out: z.string().optional() }),
    output: looseOutput,
    examples: ["thctl schema --format json", "thctl schema instance stop", "thctl schema instance --format md --out instance.md"],
    handler: schemaCommand,
  },
], { flat: true });

export const CLI_GROUPS: readonly CliGroup[] = [
  profileGroup,
  sessionGroup,
  instanceGroup,
  aiSessionGroup,
  appSessionGroup,
  nodeGroup,
  storyGroup,
  triggerGroup,
  modelGroup,
  userGroup,
  eventsGroup,
  schemaGroup,
];

export const CLI_LEAVES: readonly CliLeaf[] = CLI_GROUPS.flatMap((entry) => entry.leaves);

export function findLeaf(id: string) {
  const normalized = id.trim().replace(/\s+/g, " ");
  return CLI_LEAVES.find((leaf) => leaf.id === normalized);
}

export function leavesForGroup(group: string) {
  return CLI_LEAVES.filter((leaf) => leaf.group === group);
}

export type { ControlPlaneClient };
