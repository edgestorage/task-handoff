<template>
  <Transition
    :css="false"
    @before-enter="beforeEnter"
    @enter="enter"
    @after-enter="afterEnter"
    @enter-cancelled="enterCancelled"
    @before-leave="beforeLeave"
    @leave="leave"
    @after-leave="afterLeave"
    @leave-cancelled="leaveCancelled"
  >
    <slot />
  </Transition>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from "vue";

const HEIGHT_DURATION_MS = 180;
const OPACITY_DURATION_MS = 140;
const HEIGHT_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const SETTLE_DELAY_MS = 32;

type PendingTransition = {
  frame: number;
  timer: number;
};

const pendingTransitions = new WeakMap<HTMLElement, PendingTransition>();
const pendingElements = new Set<HTMLElement>();

function asHtmlElement(element: Element | null): HTMLElement | undefined {
  return element instanceof HTMLElement ? element : undefined;
}

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function cancelPending(element: HTMLElement) {
  const pending = pendingTransitions.get(element);
  if (!pending) return;
  cancelAnimationFrame(pending.frame);
  window.clearTimeout(pending.timer);
  pendingTransitions.delete(element);
  pendingElements.delete(element);
}

function resetElement(element: HTMLElement) {
  cancelPending(element);
  element.style.removeProperty("box-sizing");
  element.style.removeProperty("height");
  element.style.removeProperty("min-height");
  element.style.removeProperty("opacity");
  element.style.removeProperty("overflow");
  element.style.removeProperty("transition");
  element.style.removeProperty("will-change");
}

function beforeEnter(element: Element) {
  const target = asHtmlElement(element);
  if (!target) return;
  cancelPending(target);
  target.style.boxSizing = "border-box";
  target.style.overflow = "hidden";
  target.style.minHeight = "0";
  target.style.height = "0px";
  target.style.opacity = "0";
  target.style.willChange = "height, opacity";
}

function enter(element: Element, done: () => void) {
  const target = asHtmlElement(element);
  if (!target || prefersReducedMotion()) {
    if (target) resetElement(target);
    done();
    return;
  }
  // before-enter runs before Vue inserts the element, so its height is still 0.
  // Restore the natural layout after insertion, measure it, then animate from 0.
  target.style.transition = "none";
  target.style.height = "auto";
  target.style.minHeight = "";
  const height = target.getBoundingClientRect().height;
  target.style.minHeight = "0";
  target.style.height = "0px";
  void target.offsetHeight;
  target.style.transition = `height ${HEIGHT_DURATION_MS}ms ${HEIGHT_EASING}, opacity ${OPACITY_DURATION_MS}ms ease`;
  const frame = requestAnimationFrame(() => {
    target.style.height = `${height}px`;
    target.style.opacity = "1";
  });
  const timer = window.setTimeout(() => {
    pendingTransitions.delete(target);
    pendingElements.delete(target);
    done();
  }, HEIGHT_DURATION_MS + SETTLE_DELAY_MS);
  pendingTransitions.set(target, { frame, timer });
  pendingElements.add(target);
}

function afterEnter(element: Element) {
  const target = asHtmlElement(element);
  if (target) resetElement(target);
}

function enterCancelled(element: Element) {
  const target = asHtmlElement(element);
  if (target) resetElement(target);
}

function beforeLeave(element: Element) {
  const target = asHtmlElement(element);
  if (!target) return;
  cancelPending(target);
  const height = target.getBoundingClientRect().height;
  target.style.boxSizing = "border-box";
  target.style.overflow = "hidden";
  target.style.minHeight = "0";
  target.style.height = `${height}px`;
  target.style.opacity = window.getComputedStyle(target).opacity;
  target.style.willChange = "height, opacity";
  target.style.transition = "none";
}

function leave(element: Element, done: () => void) {
  const target = asHtmlElement(element);
  if (!target || prefersReducedMotion()) {
    if (target) resetElement(target);
    done();
    return;
  }
  target.style.transition = `height ${HEIGHT_DURATION_MS}ms ${HEIGHT_EASING}, opacity ${OPACITY_DURATION_MS}ms ease`;
  void target.offsetHeight;
  const frame = requestAnimationFrame(() => {
    target.style.height = "0px";
    target.style.opacity = "0";
  });
  const timer = window.setTimeout(() => {
    pendingTransitions.delete(target);
    pendingElements.delete(target);
    done();
  }, HEIGHT_DURATION_MS + SETTLE_DELAY_MS);
  pendingTransitions.set(target, { frame, timer });
  pendingElements.add(target);
}

function afterLeave(element: Element) {
  const target = asHtmlElement(element);
  if (target) resetElement(target);
}

function leaveCancelled(element: Element) {
  const target = asHtmlElement(element);
  if (target) resetElement(target);
}

onBeforeUnmount(() => {
  for (const element of [...pendingElements]) resetElement(element);
});
</script>
