const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const NO_PREFERENCE_QUERY = "(prefers-reduced-motion: no-preference)";

function callEventListener(listener, event) {
  if (typeof listener === "function") {
    listener(event);
    return;
  }
  listener.handleEvent(event);
}

export class FakeClock {
  #currentTime;
  #nextTimerId = 1;
  #timers = new Map();

  constructor(startTime = 0) {
    if (!Number.isFinite(startTime)) {
      throw new TypeError("FakeClock start time must be finite");
    }
    this.#currentTime = startTime;
  }

  now = () => this.#currentTime;

  setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== "function") {
      throw new TypeError("FakeClock timer callback must be a function");
    }
    const id = this.#nextTimerId++;
    const normalizedDelay = Number.isFinite(Number(delay))
      ? Math.max(0, Number(delay))
      : 0;
    this.#timers.set(id, {
      callback: () => callback(...args),
      dueAt: this.#currentTime + normalizedDelay,
      id,
    });
    return id;
  };

  clearTimeout = (id) => {
    this.#timers.delete(id);
  };

  get pendingTimerCount() {
    return this.#timers.size;
  }

  advanceBy(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("FakeClock can only advance by a finite non-negative duration");
    }
    this.advanceTo(this.#currentTime + milliseconds);
  }

  advanceTo(targetTime, { maxTimers = 10_000 } = {}) {
    if (!Number.isFinite(targetTime) || targetTime < this.#currentTime) {
      throw new RangeError("FakeClock cannot move backwards or to a non-finite time");
    }

    let fired = 0;
    for (;;) {
      const timer = this.#nextTimerAtOrBefore(targetTime);
      if (!timer) {
        break;
      }
      if (fired >= maxTimers) {
        throw new Error(`FakeClock exceeded the ${maxTimers} timer safety limit`);
      }
      this.#fireTimer(timer);
      fired += 1;
    }
    this.#currentTime = targetTime;
  }

  runAll({ maxTimers = 10_000 } = {}) {
    let fired = 0;
    while (this.#timers.size > 0) {
      if (fired >= maxTimers) {
        throw new Error(`FakeClock exceeded the ${maxTimers} timer safety limit`);
      }
      const timer = this.#nextTimer();
      this.#fireTimer(timer);
      fired += 1;
    }
  }

  #nextTimerAtOrBefore(targetTime) {
    const timer = this.#nextTimer();
    return timer && timer.dueAt <= targetTime ? timer : undefined;
  }

  #nextTimer() {
    let next;
    for (const timer of this.#timers.values()) {
      if (!next || timer.dueAt < next.dueAt || (timer.dueAt === next.dueAt && timer.id < next.id)) {
        next = timer;
      }
    }
    return next;
  }

  #fireTimer(timer) {
    this.#currentTime = timer.dueAt;
    this.#timers.delete(timer.id);
    timer.callback();
  }
}

export class FakeAnimationFrameScheduler {
  #clock;
  #frameDuration;
  #nextFrameId = 1;
  #callbacks = new Map();

  constructor({ clock = new FakeClock(), frameDuration = 1000 / 60 } = {}) {
    if (!Number.isFinite(frameDuration) || frameDuration <= 0) {
      throw new RangeError("Animation frame duration must be finite and positive");
    }
    this.#clock = clock;
    this.#frameDuration = frameDuration;
  }

  requestAnimationFrame = (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("Animation frame callback must be a function");
    }
    const id = this.#nextFrameId++;
    this.#callbacks.set(id, callback);
    return id;
  };

  cancelAnimationFrame = (id) => {
    this.#callbacks.delete(id);
  };

  get pendingFrameCount() {
    return this.#callbacks.size;
  }

  step(milliseconds = this.#frameDuration) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError("Animation frames can only advance by a finite non-negative duration");
    }
    this.#clock.advanceBy(milliseconds);
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    const timestamp = this.#clock.now();
    for (const callback of callbacks) {
      callback(timestamp);
    }
  }

  runFrames(count, milliseconds = this.#frameDuration) {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError("Animation frame count must be a non-negative integer");
    }
    for (let index = 0; index < count; index += 1) {
      this.step(milliseconds);
    }
  }

  flush({ maxFrames = 10_000 } = {}) {
    let frames = 0;
    while (this.#callbacks.size > 0) {
      if (frames >= maxFrames) {
        throw new Error(`Animation frame scheduler exceeded the ${maxFrames} frame safety limit`);
      }
      this.step();
      frames += 1;
    }
  }
}

export class FakePageVisibility {
  #visibilityState;
  #listeners = new Set();

  constructor(initialState = "visible") {
    this.#visibilityState = validateVisibilityState(initialState);
  }

  get visibilityState() {
    return this.#visibilityState;
  }

  get hidden() {
    return this.#visibilityState === "hidden";
  }

  isVisible = () => !this.hidden;

  addEventListener = (type, listener) => {
    if (type === "visibilitychange") {
      this.#listeners.add(listener);
    }
  };

  removeEventListener = (type, listener) => {
    if (type === "visibilitychange") {
      this.#listeners.delete(listener);
    }
  };

  subscribe = (listener) => {
    const wrapped = () => listener(this.isVisible());
    this.#listeners.add(wrapped);
    return () => this.#listeners.delete(wrapped);
  };

  setVisibility(state) {
    const nextState = validateVisibilityState(state);
    if (nextState === this.#visibilityState) {
      return;
    }
    this.#visibilityState = nextState;
    const event = { type: "visibilitychange", target: this, currentTarget: this };
    for (const listener of [...this.#listeners]) {
      callEventListener(listener, event);
    }
  }
}

class FakeMediaQueryList {
  #owner;
  #listeners = new Set();

  constructor(owner, media) {
    this.#owner = owner;
    this.media = media;
  }

  get matches() {
    if (this.media === REDUCED_MOTION_QUERY) {
      return this.#owner.reduced;
    }
    if (this.media === NO_PREFERENCE_QUERY) {
      return !this.#owner.reduced;
    }
    return false;
  }

  addEventListener = (type, listener) => {
    if (type === "change") {
      this.#listeners.add(listener);
    }
  };

  removeEventListener = (type, listener) => {
    if (type === "change") {
      this.#listeners.delete(listener);
    }
  };

  addListener = (listener) => this.#listeners.add(listener);

  removeListener = (listener) => this.#listeners.delete(listener);

  dispatchChange() {
    const event = { type: "change", media: this.media, matches: this.matches, target: this, currentTarget: this };
    for (const listener of [...this.#listeners]) {
      callEventListener(listener, event);
    }
  }
}

export class FakeReducedMotion {
  #queries = new Map();

  constructor(reduced = false) {
    this.reduced = Boolean(reduced);
  }

  matches = () => this.reduced;

  matchMedia = (query) => {
    let mediaQuery = this.#queries.get(query);
    if (!mediaQuery) {
      mediaQuery = new FakeMediaQueryList(this, query);
      this.#queries.set(query, mediaQuery);
    }
    return mediaQuery;
  };

  subscribe = (listener) => {
    const mediaQuery = this.matchMedia(REDUCED_MOTION_QUERY);
    const wrapped = (event) => listener(event.matches);
    mediaQuery.addEventListener("change", wrapped);
    return () => mediaQuery.removeEventListener("change", wrapped);
  };

  setReducedMotion(reduced) {
    const next = Boolean(reduced);
    if (next === this.reduced) {
      return;
    }
    this.reduced = next;
    for (const mediaQuery of this.#queries.values()) {
      mediaQuery.dispatchChange();
    }
  }
}

export function createStreamingTestEnvironment(options = {}) {
  const clock = new FakeClock(options.startTime);
  const animationFrames = new FakeAnimationFrameScheduler({
    clock,
    frameDuration: options.frameDuration,
  });
  const visibility = new FakePageVisibility(options.visibilityState);
  const reducedMotion = new FakeReducedMotion(options.reducedMotion);

  return {
    animationFrames,
    clock,
    document: visibility,
    reducedMotion,
    visibility,
    window: {
      cancelAnimationFrame: animationFrames.cancelAnimationFrame,
      matchMedia: reducedMotion.matchMedia,
      requestAnimationFrame: animationFrames.requestAnimationFrame,
    },
  };
}

function validateVisibilityState(state) {
  if (state !== "visible" && state !== "hidden") {
    throw new TypeError('Page visibility must be either "visible" or "hidden"');
  }
  return state;
}

export { NO_PREFERENCE_QUERY, REDUCED_MOTION_QUERY };
