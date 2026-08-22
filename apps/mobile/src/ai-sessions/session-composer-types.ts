import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';
import type { Animated } from 'react-native';

export type SessionComposerAction = 'save' | 'send' | 'stop';

export type SessionComposerProps = {
  action: SessionComposerAction;
  actionBusy: boolean;
  actionDisabled: boolean;
  editable: boolean;
  editingLabel?: string;
  expansion: Animated.Value;
  fileDisabled: boolean;
  focused: boolean;
  focusRequestKey?: number;
  imageDisabled: boolean;
  permissionEnabled: boolean;
  permissionMode: AiSessionPermissionMode;
  runtimeFileDisabled: boolean;
  value: string;
  onAction(): void;
  onAddFile(): void;
  onAddImage(): void;
  onAddRuntimeFile(): void;
  onPasteImages(uris: string[]): void;
  onPasteText(text: string): void;
  onCancelEdit?(): void;
  onFocusChange(focused: boolean): void;
  onPermissionModeChange(mode: AiSessionPermissionMode): void;
  onValueChange(value: string): void;
};
