export const STORY_TOOL_NAMES = [
  "story_list_content",
  "story_get_content",
  "story_set_content",
] as const;

export type StoryToolName = typeof STORY_TOOL_NAMES[number];

export const STORY_TOOL_DESCRIPTIONS: Record<StoryToolName, string> = {
  story_list_content: "List a page of indexed documents in the Story assigned to the current AI Session, ordered newest to oldest. Start with page 1, increment page while pagination.hasMore is true, then pass selected storyPath values to story_get_content.",
  story_get_content: "Copy one or more Story documents selected by exact storyPath from story_list_content into a directory in the current workspace. Files retain their Story-relative paths; read the returned local paths with workspace tools.",
  story_set_content: "Create or replace one indexed Story document from a regular file in the current workspace. A new document requires title; replacing one requires the expectedRevision returned by story_list_content or story_get_content.",
};
