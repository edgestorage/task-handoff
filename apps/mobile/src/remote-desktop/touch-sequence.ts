export type RemoteDesktopTouchSequence = {
  active: number;
  multi: boolean;
};

export type RemoteDesktopMultiTouchTapCandidate = {
  eligible: boolean;
  intent: 'pending' | 'scroll' | 'pinch';
  startedAt: number;
};

export const EMPTY_REMOTE_DESKTOP_TOUCH_SEQUENCE: RemoteDesktopTouchSequence = {
  active: 0,
  multi: false,
};

function touchCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Starts a new touch sequence after the previous sequence has fully ended. */
export function startRemoteDesktopTouchSequence(
  state: RemoteDesktopTouchSequence,
  active: number,
): RemoteDesktopTouchSequence {
  const nextActive = touchCount(active);
  return {
    active: nextActive,
    multi: (state.active > 0 ? state.multi : false) || nextActive > 1,
  };
}

export function updateRemoteDesktopTouchSequence(
  state: RemoteDesktopTouchSequence,
  active: number,
): RemoteDesktopTouchSequence {
  const nextActive = touchCount(active);
  return { active: nextActive, multi: state.multi || nextActive > 1 };
}

/** A sequence that ever contained multiple touches remains non-tappable. */
export function suppressRemoteDesktopTap(state: RemoteDesktopTouchSequence) {
  return state.multi;
}

/** A still two-finger gesture becomes a right click; scroll/pinch or a long hold does not. */
export function canCommitRemoteDesktopMultiTouchTap(
  candidate: RemoteDesktopMultiTouchTapCandidate,
  now: number,
  maxDurationMs = 700,
) {
  const duration = now - candidate.startedAt;
  return candidate.eligible
    && candidate.intent === 'pending'
    && Number.isFinite(duration)
    && duration >= 0
    && duration <= maxDurationMs;
}
