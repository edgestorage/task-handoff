export const RESOURCE_NAME_MAX_LENGTH = 160;

export type ResourceNameValidation = 'required' | 'too-long' | 'unchanged' | undefined;

export function validateResourceName(draft: string, currentName: string): ResourceNameValidation {
  const name = draft.trim();
  if (!name) return 'required';
  if (name.length > RESOURCE_NAME_MAX_LENGTH) return 'too-long';
  if (name === currentName) return 'unchanged';
  return undefined;
}
