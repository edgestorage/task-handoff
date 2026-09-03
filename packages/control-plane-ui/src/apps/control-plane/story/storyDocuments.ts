export const STORY_TREE_DOCUMENT_LIMIT = 5;

export function latestStoryDocuments<T>(documents: readonly T[], expanded: boolean): readonly T[] {
  return expanded || documents.length <= STORY_TREE_DOCUMENT_LIMIT
    ? documents
    : documents.slice(-STORY_TREE_DOCUMENT_LIMIT);
}
