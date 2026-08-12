export function canPublishTerminalResize(input: { active: boolean; visible: boolean; focused: boolean; applyingRemoteResize: boolean }) {
  return input.active && input.visible && input.focused && !input.applyingRemoteResize;
}
