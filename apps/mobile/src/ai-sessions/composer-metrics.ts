import type { AiSessionPermissionMode } from '@task-handoff/protocol/ai-sessions';

export const SESSION_COMPOSER_EXPANDED_RADIUS = 22;
export const SESSION_COMPOSER_COLLAPSED_HEIGHT = 56;
export const SESSION_COMPOSER_EXPANDED_HEIGHT = 152;
export const SESSION_COMPOSER_ACTION_SIZE = 38;
export const SESSION_COMPOSER_ACTION_RADIUS = SESSION_COMPOSER_ACTION_SIZE / 2;
export const SESSION_COMPOSER_ACTION_ICON_SIZE = 17;
export const SESSION_COMPOSER_TOOLBAR_HEIGHT = 56;
export const SESSION_COMPOSER_TOOL_SIZE = 40;
export const SESSION_COMPOSER_ATTACHMENT_ICON_SIZE = 25;

export function sessionComposerPermissionIconSize(mode: AiSessionPermissionMode) {
  return mode === 'ask' ? 21 : 22;
}
