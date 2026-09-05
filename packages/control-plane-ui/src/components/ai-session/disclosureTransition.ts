const scrollAnchorLocks = new WeakMap<HTMLElement, { count: number; previous: string }>();
const pendingScrollAnchorLocks = new WeakMap<HTMLElement, number>();
const transitionViewports = new WeakMap<Element, HTMLElement>();
const transitionFrames = new WeakMap<Element, Set<number>>();

function lockScrollAnchor(viewport: HTMLElement) {
  const lock = scrollAnchorLocks.get(viewport);
  if (lock) {
    lock.count += 1;
    return;
  }
  scrollAnchorLocks.set(viewport, { count: 1, previous: viewport.style.overflowAnchor });
  viewport.style.overflowAnchor = "none";
}

function unlockScrollAnchor(viewport: HTMLElement) {
  const lock = scrollAnchorLocks.get(viewport);
  if (!lock) return;
  lock.count -= 1;
  if (lock.count > 0) return;
  viewport.style.overflowAnchor = lock.previous;
  scrollAnchorLocks.delete(viewport);
}

export function beginDisclosureTransition(element: Element) {
  const viewport = element.closest<HTMLElement>("[data-task-handoff-scroll-viewport]");
  if (!viewport) return;
  lockScrollAnchor(viewport);
  pendingScrollAnchorLocks.set(viewport, (pendingScrollAnchorLocks.get(viewport) || 0) + 1);
}

function adoptScrollAnchorLock(element: Element) {
  if (transitionViewports.has(element)) return;
  const viewport = element.closest<HTMLElement>("[data-task-handoff-scroll-viewport]");
  if (!viewport) return;
  const pending = pendingScrollAnchorLocks.get(viewport) || 0;
  if (pending > 0) {
    pendingScrollAnchorLocks.set(viewport, pending - 1);
  } else {
    lockScrollAnchor(viewport);
  }
  transitionViewports.set(element, viewport);
}

function releaseScrollAnchorLock(element: Element) {
  const viewport = transitionViewports.get(element);
  if (!viewport) return;
  transitionViewports.delete(element);
  unlockScrollAnchor(viewport);
}

function scheduleTransitionFrame(element: Element, update: () => void) {
  const frame = requestAnimationFrame(() => {
    transitionFrames.get(element)?.delete(frame);
    update();
  });
  let frames = transitionFrames.get(element);
  if (!frames) {
    frames = new Set();
    transitionFrames.set(element, frames);
  }
  frames.add(frame);
}

function cancelTransitionFrames(element: Element) {
  const frames = transitionFrames.get(element);
  if (!frames) return;
  for (const frame of frames) cancelAnimationFrame(frame);
  frames.clear();
}

export function prepareDisclosureEnter(element: Element) {
  const panel = element as HTMLElement;
  panel.style.height = "0px";
  panel.style.overflow = "hidden";
}

export function runDisclosureEnter(element: Element) {
  adoptScrollAnchorLock(element);
  const panel = element as HTMLElement;
  scheduleTransitionFrame(element, () => {
    panel.style.height = `${panel.scrollHeight}px`;
  });
}

export function finishDisclosureEnter(element: Element) {
  cancelTransitionFrames(element);
  const panel = element as HTMLElement;
  panel.style.height = "auto";
  panel.style.overflow = "";
  releaseScrollAnchorLock(element);
}

export function prepareDisclosureLeave(element: Element) {
  adoptScrollAnchorLock(element);
  const panel = element as HTMLElement;
  panel.style.height = `${panel.getBoundingClientRect().height}px`;
  panel.style.overflow = "hidden";
}

export function runDisclosureLeave(element: Element) {
  const panel = element as HTMLElement;
  scheduleTransitionFrame(element, () => {
    panel.style.height = "0px";
  });
}

export function finishDisclosureLeave(element: Element) {
  cancelTransitionFrames(element);
  const panel = element as HTMLElement;
  panel.style.height = "";
  panel.style.overflow = "";
  releaseScrollAnchorLock(element);
}

export function cancelDisclosureTransition(element: Element) {
  cancelTransitionFrames(element);
  const panel = element as HTMLElement;
  panel.style.height = "";
  panel.style.overflow = "";

  if (transitionViewports.has(element)) {
    releaseScrollAnchorLock(element);
    return;
  }

  const viewport = element.closest<HTMLElement>("[data-task-handoff-scroll-viewport]");
  if (!viewport) return;
  const pending = pendingScrollAnchorLocks.get(viewport) || 0;
  if (pending > 0) {
    pendingScrollAnchorLocks.set(viewport, pending - 1);
    unlockScrollAnchor(viewport);
  }
}
