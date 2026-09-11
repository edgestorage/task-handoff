export type StorySelection =
  | { kind: "story"; ownerNodeId: string; storyId: string }
  | { kind: "document"; ownerNodeId: string; storyId: string; storyPath: string }
  | { kind: "session"; ownerNodeId: string; storyId: string; instanceId: string; sessionId: string };

export function storySelectionKey(selection: StorySelection | undefined) {
  if (!selection) return "";
  const storyKey = `${selection.ownerNodeId}:${selection.storyId}`;
  if (selection.kind === "document") return `${selection.kind}:${storyKey}:${selection.storyPath}`;
  if (selection.kind === "session") return `${selection.kind}:${storyKey}:${selection.instanceId}:${selection.sessionId}`;
  return `${selection.kind}:${storyKey}`;
}
