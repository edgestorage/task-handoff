import assert from "node:assert/strict";
import test from "node:test";
import {
  parseInputSuspension,
  REMOTE_DESKTOP_GEOMETRY_CHANGED,
  shouldResumeAfterInputError,
  shouldResumeAfterInputSuspension,
} from "../src/apps/control-plane/instance-detail/remoteDesktopInputSuspension.ts";

const ready = {
  inputRequested: true,
  isController: true,
  surfacePaused: false,
  documentFocused: true,
};

test("geometry suspension carries the authoritative revision and recovers in place", () => {
  const notice = parseInputSuspension({
    type: "input.suspended",
    payload: {
      cause: REMOTE_DESKTOP_GEOMETRY_CHANGED,
      recoverable: true,
      sessionRevision: 42,
    },
  });
  assert.deepEqual(notice, {
    cause: REMOTE_DESKTOP_GEOMETRY_CHANGED,
    recoverable: true,
    sessionRevision: 42,
  });
  assert.equal(shouldResumeAfterInputSuspension(notice, ready), true);
});

test("any recoverable input suspension resumes while the viewer still owns input", () => {
  const notice = parseInputSuspension({
    type: "input.suspended",
    payload: {
      cause: "REMOTE_DESKTOP_WINDOW_FOCUS_REQUIRED",
      recoverable: true,
      sessionRevision: 43,
    },
  });
  assert.equal(shouldResumeAfterInputSuspension(notice, ready), true);
});

test("recoverable asynchronous input errors resume only for an active controller", () => {
  assert.equal(shouldResumeAfterInputError(true, ready), true);
  assert.equal(shouldResumeAfterInputError(false, ready), false);
  for (const state of [
    { ...ready, inputRequested: false },
    { ...ready, isController: false },
    { ...ready, surfacePaused: true },
  ]) {
    assert.equal(shouldResumeAfterInputError(true, state), false);
  }
});

test("manual suspension and unavailable recovery context stay released", () => {
  assert.equal(shouldResumeAfterInputSuspension(parseInputSuspension({ type: "input.suspended" }), ready), false);
  const notice = parseInputSuspension({
    payload: { cause: REMOTE_DESKTOP_GEOMETRY_CHANGED, recoverable: true, sessionRevision: 7 },
  });
  for (const state of [
    { ...ready, inputRequested: false },
    { ...ready, isController: false },
    { ...ready, surfacePaused: true },
    { ...ready, documentFocused: false },
  ]) {
    assert.equal(shouldResumeAfterInputSuspension(notice, state), false);
  }
  assert.equal(shouldResumeAfterInputSuspension({ ...notice, sessionRevision: undefined }, ready), false);
});
