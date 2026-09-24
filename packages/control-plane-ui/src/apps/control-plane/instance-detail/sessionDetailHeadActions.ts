/**
 * The AI session detail header keeps the session context (path, instance, agent, status) in the same
 * row cell as the head actions (turn navigator, repository environment pill, session details, "..."
 * menu). The pane is often much narrower than the app viewport because of the session sidebar, the
 * story rail or split panes, and from a certain width on the row can no longer show both: the pill and
 * the details button then move into the "..." menu instead of overlapping the context labels.
 *
 * The decision is measured on the pane, not on the viewport, and keeps the action width it measured
 * while the row was expanded. While collapsed only the "..." trigger is rendered, so re-expanding
 * requires the full row plus slack to fit; that keeps the row from flapping while a pane divider is
 * dragged across the breakpoint.
 */

/** Room the context row keeps for the session path next to its instance, agent and status segments. */
export const DETAIL_HEAD_MIN_CONTEXT_WIDTH = 320;
export const DETAIL_HEAD_EXPAND_SLACK = 24;

export type DetailHeadActionsOverflow = {
  collapsed: boolean;
  /** Width of the fully expanded head actions, measured while the row was expanded. */
  expandedActionsWidth: number;
};

export type DetailHeadActionsMeasurement = {
  /** Width available to the header row inside the session detail pane. */
  availableWidth: number;
  /** Width of the head actions as currently rendered. */
  actionsWidth: number;
};

export function nextDetailHeadActionsOverflow(
  current: DetailHeadActionsOverflow,
  measured: DetailHeadActionsMeasurement,
): DetailHeadActionsOverflow {
  const availableWidth = measured.availableWidth;
  const actionsWidth = measured.actionsWidth;
  // Hidden panes report a zero width; keep the last decision until the row is measurable again.
  if (!(availableWidth > 0) || !(actionsWidth > 0)) return current;
  if (!current.collapsed) {
    return { collapsed: availableWidth < actionsWidth + DETAIL_HEAD_MIN_CONTEXT_WIDTH, expandedActionsWidth: actionsWidth };
  }
  // The collapsed row only renders the "..." trigger, so the row reopens against the width measured
  // before collapsing instead of the shrunken width on screen.
  const required = current.expandedActionsWidth + DETAIL_HEAD_MIN_CONTEXT_WIDTH + DETAIL_HEAD_EXPAND_SLACK;
  return availableWidth >= required
    ? { collapsed: false, expandedActionsWidth: current.expandedActionsWidth }
    : current;
}
