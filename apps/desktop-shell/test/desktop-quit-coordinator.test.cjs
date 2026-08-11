const assert = require("node:assert/strict");
const test = require("node:test");
const { createDesktopQuitCoordinator } = require("../src/desktop-quit-coordinator.cjs");

test("desktop quit coordinator merges concurrent quit sources", async () => {
  const calls = [];
  let release;
  const coordinator = createDesktopQuitCoordinator({
    stop: (reason) => new Promise((resolve) => { calls.push(reason); release = resolve; }),
  });
  const quit = coordinator.request("quit");
  const update = coordinator.request("update");
  assert.equal(quit, update);
  assert.equal(coordinator.phase(), "stopping");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await quit;
  assert.deepEqual(calls, ["quit"]);
  assert.equal(coordinator.isReadyToExit(), true);
});

test("desktop quit coordinator reaches ready state after diagnosed cleanup failure", async () => {
  const errors = [];
  const coordinator = createDesktopQuitCoordinator({
    stop: async () => { throw new Error("shutdown failed"); },
    onError: (error, reason) => errors.push([error.message, reason]),
  });
  await coordinator.request("quit");
  assert.deepEqual(errors, [["shutdown failed", "quit"]]);
  assert.equal(coordinator.isReadyToExit(), true);
});
