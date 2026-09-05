import { nextTick, type ObjectDirective } from "vue";

type HorizontalOverflowObservation = {
  observer: ResizeObserver;
  children: Set<Element>;
};

const observations = new WeakMap<HTMLElement, HorizontalOverflowObservation>();

export function updateHorizontalOverflow(element: HTMLElement) {
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  element.dataset.overflowStart = String(element.scrollLeft > 1);
  element.dataset.overflowEnd = String(element.scrollLeft < maxScrollLeft - 1);
}

function syncObservedChildren(element: HTMLElement, observation: HorizontalOverflowObservation) {
  const children = new Set(Array.from(element.children));
  for (const child of observation.children) {
    if (!children.has(child)) observation.observer.unobserve(child);
  }
  for (const child of children) {
    if (!observation.children.has(child)) observation.observer.observe(child);
  }
  observation.children = children;
}

export const vHorizontalOverflow: ObjectDirective<HTMLElement> = {
  mounted(element) {
    if (typeof ResizeObserver !== "undefined") {
      const observation: HorizontalOverflowObservation = {
        observer: new ResizeObserver(() => updateHorizontalOverflow(element)),
        children: new Set(),
      };
      observation.observer.observe(element);
      syncObservedChildren(element, observation);
      observations.set(element, observation);
    }
    updateHorizontalOverflow(element);
  },
  updated(element) {
    void nextTick(() => {
      const observation = observations.get(element);
      if (observation) syncObservedChildren(element, observation);
      updateHorizontalOverflow(element);
    });
  },
  unmounted(element) {
    observations.get(element)?.observer.disconnect();
    observations.delete(element);
  },
};

export function updateHorizontalOverflowFromEvent(event: Event) {
  if (event.currentTarget instanceof HTMLElement) updateHorizontalOverflow(event.currentTarget);
}

export function scrollHorizontalOverflow(event: WheelEvent) {
  const element = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  if (!element || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || element.scrollWidth <= element.clientWidth) return;
  const nextScrollLeft = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, element.scrollLeft + event.deltaY));
  if (nextScrollLeft === element.scrollLeft) return;
  event.preventDefault();
  element.scrollLeft = nextScrollLeft;
  updateHorizontalOverflow(element);
}
