import type { AiSessionHistoryItem } from '@task-handoff/protocol/ai-sessions';

export type InstanceOverviewProps = {
  nodeName: string;
  runtime: string;
  workspace: string;
  heartbeat: string;
  protocol: string;
  protocolCompatible: boolean;
  activeSessionCount: number;
  problemSessionCount: number;
  onCreateSession(): void;
  onShowSessions(): void;
};

export type InstanceHistoryProps = {
  items: AiSessionHistoryItem[];
  loading: boolean;
  onOpen(item: AiSessionHistoryItem): void;
};
