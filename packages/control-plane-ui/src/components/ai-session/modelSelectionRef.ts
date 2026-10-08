/**
 * UI-side identity comparison for model selections.
 *
 * `modelName` is a display label the operator may rename at any time, so it must
 * never be the identity. `modelUpstreamName` is the stable identity and is what
 * comparisons use; the label is only a fallback for records written before the
 * identity existed. Entity ids are compared when both sides carry one, which
 * keeps an unsaved draft (empty id) comparable to a catalog option.
 */
export type ModelSelectionRef = {
  modelEntityId?: string;
  modelName?: string;
  modelUpstreamName?: string;
};

export function modelSelectionIdentity(selection: ModelSelectionRef) {
  return selection.modelUpstreamName || selection.modelName;
}

export function sameModelSelectionRef(left: ModelSelectionRef, right: ModelSelectionRef) {
  if (left.modelEntityId && right.modelEntityId && left.modelEntityId !== right.modelEntityId) return false;
  const leftIdentity = modelSelectionIdentity(left);
  const rightIdentity = modelSelectionIdentity(right);
  if (!leftIdentity || !rightIdentity) return false;
  return leftIdentity === rightIdentity || left.modelName === right.modelName;
}
