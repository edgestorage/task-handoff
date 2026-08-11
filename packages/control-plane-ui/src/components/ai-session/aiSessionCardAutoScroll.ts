import type { ObjectDirective } from "vue";

const HOVER_DELAY_MS = 1000;
const WHEEL_RESUME_DELAY_MS = 1000;
const SCROLL_SPEED_PX_PER_SECOND = 28;

export interface AiSessionCardAutoScrollBinding {
  revision: string | number;
  target: string;
}

class AiSessionCardAutoScrollController {
  private frame: number | undefined;
  private hoverTimer: number | undefined;
  private idleActive = false;
  private lastFrameTime: number | undefined;
  private pointerInside = false;
  private resumeTimer: number | undefined;
  private revision: string | number;
  private target: HTMLElement | undefined;
  private targetSelector: string;

  constructor(private readonly root: HTMLElement, binding: AiSessionCardAutoScrollBinding) {
    this.revision = binding.revision;
    this.targetSelector = binding.target;
    this.resolveTarget();
  }

  update(binding: AiSessionCardAutoScrollBinding) {
    const revisionChanged = binding.revision !== this.revision;
    this.revision = binding.revision;
    if (binding.target !== this.targetSelector) {
      this.targetSelector = binding.target;
      this.resolveTarget();
    } else if (!this.target?.isConnected) {
      this.resolveTarget();
    }
    if (revisionChanged) {
      this.reset();
      if (this.pointerInside) this.scheduleStart(HOVER_DELAY_MS);
      return;
    }
    if (this.pointerInside && this.idleActive && this.frame === undefined && this.hoverTimer === undefined && this.resumeTimer === undefined) {
      this.start();
    }
  }

  dispose() {
    this.pointerInside = false;
    this.idleActive = false;
    this.stop();
    this.clearTimers();
    this.detachTargetListeners();
  }

  private readonly handlePointerEnter = () => {
    this.pointerInside = true;
    this.idleActive = false;
    this.scheduleStart(HOVER_DELAY_MS);
  };

  private readonly handlePointerMove = () => {
    if (!this.pointerInside) return;
    this.idleActive = false;
    this.stop();
    this.scheduleStart(HOVER_DELAY_MS);
  };

  private readonly handlePointerLeave = () => {
    this.pointerInside = false;
    this.idleActive = false;
    this.stop();
    this.clearTimers();
    if (this.target) this.target.scrollTop = 0;
  };

  private readonly handleWheel = (event: WheelEvent) => {
    const target = this.target;
    if (!this.pointerInside || !this.idleActive || !target || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
    if (maxScrollTop <= 0) return;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? target.clientHeight
        : 1;
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, target.scrollTop + event.deltaY * unit));
    if (nextScrollTop === target.scrollTop) return;
    event.preventDefault();
    event.stopPropagation();
    this.stop();
    this.clearTimers();
    target.scrollTop = nextScrollTop;
    this.resumeTimer = window.setTimeout(() => {
      this.resumeTimer = undefined;
      if (this.pointerInside) this.start();
    }, WHEEL_RESUME_DELAY_MS);
  };

  private resolveTarget() {
    const target = this.root.querySelector<HTMLElement>(this.targetSelector) || undefined;
    if (target === this.target) return;
    this.detachTargetListeners();
    this.target = target;
    this.target?.addEventListener("pointerenter", this.handlePointerEnter);
    this.target?.addEventListener("pointermove", this.handlePointerMove);
    this.target?.addEventListener("pointerleave", this.handlePointerLeave);
    this.target?.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private detachTargetListeners() {
    this.target?.removeEventListener("pointerenter", this.handlePointerEnter);
    this.target?.removeEventListener("pointermove", this.handlePointerMove);
    this.target?.removeEventListener("pointerleave", this.handlePointerLeave);
    this.target?.removeEventListener("wheel", this.handleWheel);
  }

  private scheduleStart(delay: number) {
    this.clearTimers();
    this.hoverTimer = window.setTimeout(() => {
      this.hoverTimer = undefined;
      if (this.pointerInside) this.activateIdleScroll();
    }, delay);
  }

  private activateIdleScroll() {
    const target = this.target;
    this.idleActive = Boolean(target && target.scrollHeight > target.clientHeight);
    if (this.idleActive) this.start();
  }

  private start() {
    const target = this.target;
    if (!target || target.scrollHeight <= target.clientHeight || this.prefersReducedMotion()) return;
    if (target.scrollTop >= target.scrollHeight - target.clientHeight - 0.5 || this.frame !== undefined) return;
    this.lastFrameTime = undefined;
    this.frame = window.requestAnimationFrame(this.advance);
  }

  private readonly advance = (time: number) => {
    this.frame = undefined;
    if (!this.pointerInside || !this.target) return;
    const elapsed = this.lastFrameTime === undefined ? 0 : Math.min(time - this.lastFrameTime, 50);
    this.lastFrameTime = time;
    const maxScrollTop = Math.max(0, this.target.scrollHeight - this.target.clientHeight);
    this.target.scrollTop = Math.min(maxScrollTop, this.target.scrollTop + elapsed * SCROLL_SPEED_PX_PER_SECOND / 1000);
    if (this.target.scrollTop < maxScrollTop - 0.5) {
      this.frame = window.requestAnimationFrame(this.advance);
    }
  };

  private stop() {
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.lastFrameTime = undefined;
  }

  private clearTimers() {
    if (this.hoverTimer !== undefined) window.clearTimeout(this.hoverTimer);
    if (this.resumeTimer !== undefined) window.clearTimeout(this.resumeTimer);
    this.hoverTimer = undefined;
    this.resumeTimer = undefined;
  }

  private reset() {
    this.idleActive = false;
    this.stop();
    this.clearTimers();
    if (this.target) this.target.scrollTop = 0;
  }

  private prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }
}

const controllers = new WeakMap<HTMLElement, AiSessionCardAutoScrollController>();

export const vAiSessionCardAutoScroll: ObjectDirective<HTMLElement, AiSessionCardAutoScrollBinding> = {
  mounted(element, binding) {
    controllers.set(element, new AiSessionCardAutoScrollController(element, binding.value));
  },
  updated(element, binding) {
    controllers.get(element)?.update(binding.value);
  },
  unmounted(element) {
    controllers.get(element)?.dispose();
    controllers.delete(element);
  },
};
