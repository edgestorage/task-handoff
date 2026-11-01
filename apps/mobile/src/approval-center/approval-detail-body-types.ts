import type { ApprovalCenterItem } from '@task-handoff/control-plane-client';

export type ApprovalDetailBodyProps = {
  busy: boolean;
  errorText?: string;
  failed: boolean;
  item: ApprovalCenterItem;
  optionId?: string;
  response: string;
  retryStory: boolean;
  roleUnavailable: boolean;
  sourceUnavailable: boolean;
  onDecision(decision: string): void;
  onOption(value?: string): void;
  onResponse(value: string): void;
  onSubmitStory(): void;
};
