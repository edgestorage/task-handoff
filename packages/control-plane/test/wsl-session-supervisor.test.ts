import assert from "node:assert/strict";
import test from "node:test";
import { WslSessionSupervisor, type WslSessionDiagnostic } from "../src/node-agent/runtimes/wsl-session-supervisor.ts";

function supervisor(overrides: {
  alive?: boolean;
  distroState?: "running" | "stopped" | "absent" | "unknown";
  unitActive?: string;
  healthy?: boolean;
  budgetMs?: number;
  onLost?: () => void;
} = {}) {
  const diagnostics: WslSessionDiagnostic[] = [];
  const events: string[] = [];
  let alive = overrides.alive ?? false;
  const sup = new WslSessionSupervisor({
    listRunningInstances: () => [{ id: "inst_a", distroName: "th-wsl-inst_a" }],
    holdSession: async () => { events.push("hold"); alive = true; return { name: "th-wsl-inst_a", alive: () => alive, stop: async () => { alive = false; } }; },
    sessionAlive: () => alive,
    releaseSession: async () => { alive = false; },
    distroState: async () => { events.push("distroState"); return overrides.distroState ?? "stopped"; },
    ensureDistroRunning: async () => { events.push("ensureRunning"); },
    unitActive: async () => { events.push("unitActive"); return overrides.unitActive ?? "active"; },
    waitForEndpointHealthy: async () => overrides.healthy ?? true,
    onDiagnostic: (event) => diagnostics.push(event),
    onSessionLost: () => { events.push("onLost"); overrides.onLost?.(); },
    recoveryBudgetMs: overrides.budgetMs ?? 5_000,
    delay: async () => {},
  });
  return { sup, diagnostics, events, isAlive: () => alive };
}

test("an alive keep-alive session is left untouched", async () => {
  const { sup, diagnostics, events } = supervisor({ alive: true });
  assert.equal(await sup.checkOnce(), 0);
  assert.deepEqual(events, []);
  assert.deepEqual(diagnostics, []);
});

test("a lost session is rebuilt and classified as a reclaimed distro", async () => {
  const { sup, diagnostics, events } = supervisor({ distroState: "stopped" });
  assert.equal(await sup.checkOnce(), 1);
  assert.deepEqual(events, ["distroState", "onLost", "ensureRunning", "hold", "unitActive"]);
  assert.equal(diagnostics[0].code, "WSL_SESSION_LOST");
  assert.equal(diagnostics[0].classification, "session-lost");
  assert.equal(diagnostics.at(-1)?.code, "WSL_SESSION_RECOVERED");
});

test("a running distro with a lost session is classified as an instance crash", async () => {
  const { sup, diagnostics, events } = supervisor({ distroState: "running" });
  await sup.checkOnce();
  assert.ok(!events.includes("ensureRunning"));
  assert.equal(diagnostics[0].classification, "instance-crash");
});

test("an unhealthy endpoint within budget fails structured without being treated as recovered", async () => {
  const { sup, diagnostics } = supervisor({ distroState: "stopped", healthy: false, budgetMs: 0 });
  await sup.checkOnce();
  assert.equal(diagnostics.at(-1)?.code, "WSL_SESSION_RECOVERY_FAILED");
});

test("releaseFor drops the supervisor's rebuild state and releases the session", async () => {
  const { sup, isAlive } = supervisor({ alive: true });
  await sup.releaseFor("inst_a", "th-wsl-inst_a");
  assert.equal(isAlive(), false);
});
