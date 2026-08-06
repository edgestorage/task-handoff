import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

export type SessionComposerAction = 'send' | 'stop';

export type SessionComposerProps = {
  action: SessionComposerAction;
  actionDisabled: boolean;
  editable: boolean;
  fileDisabled: boolean;
  focused: boolean;
  imageDisabled: boolean;
  permissionEnabled: boolean;
  permissionMode: AiSessionPermissionMode;
  runtimeFileDisabled: boolean;
  value: string;
  onAction(): void;
  onAddFile(): void;
  onAddImage(): void;
  onAddRuntimeFile(): void;
  onFocusChange(focused: boolean): void;
  onPermissionModeChange(mode: AiSessionPermissionMode): void;
  onValueChange(value: string): void;
};
