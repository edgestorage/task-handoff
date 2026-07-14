import type { AiSessionSummary, InstanceWithAiSessions } from "../../../api/types";
import type { SessionTab } from "../useInstanceSessions";

export type AiBoardCard = {
  appTab: SessionTab;
  instance: InstanceWithAiSessions;
  key: string;
  session: AiSessionSummary;
};

export type AiBoardColumnKey = "running" | "waiting" | "idle-open" | "problem";
