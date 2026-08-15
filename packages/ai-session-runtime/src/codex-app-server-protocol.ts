/**
 * Compatibility facade for the Codex app-server protocol surface.
 * Runtime modules should import their concrete dependency directly.
 */
export type {
  JsonValue,
  CodexThreadStatus,
  CodexThread,
  CodexApprovalKind,
  CodexApprovalRequest,
  CodexToolDescriptor,
  CodexToolActivityState,
  CodexSubAgentUpdate,
  CodexAppServerEvent,
} from "./codex-app-server/protocol/types";

export { asRecord } from "./codex-app-server/protocol/values";
export {
  codexThreadItemKind,
  codexToolDescriptor,
  codexSubAgentUpdates,
} from "./codex-app-server/protocol/items";
export { codexNotification } from "./codex-app-server/protocol/events";
export {
  CodexSubAgentTracker,
  CodexToolActivityTracker,
  rebuildCodexToolActivity,
  rebuildCodexSubAgents,
} from "./codex-app-server/protocol/activity";
export {
  codexApprovalRequest,
  approvalResponseForRequest,
  approvalDecisionVerb,
} from "./codex-app-server/protocol/approvals";
export { summarizeThreadTurns } from "./codex-app-server/protocol/thread-summary";
export { codexItemTimeline, codexThreadTimeline, mergeCodexTimelineItems } from "./codex-app-server/protocol/timeline";
export {
  turnIdFromResult,
  isNoActiveTurnError,
  activeTurnMismatchFoundId,
} from "./codex-app-server/protocol/turn-control";
export { lifecycleForStatus } from "./codex-app-server/protocol/status";
export { waitFor } from "./codex-app-server/protocol/async";
