import { ref } from "vue";
import type { CloudDeviceTrustDecision, CloudDeviceTrustRevoke, CloudDeviceTrustSnapshot } from "@task-handoff/protocol/device-trust";
import { applyDeviceTrustSnapshot, EMPTY_DEVICE_TRUST_SNAPSHOT, shouldRecoverDeviceTrust, type DeviceTrustViewSnapshot } from "./deviceTrustState.ts";

export type DeviceTrustStoreClient = {
  snapshot(): Promise<CloudDeviceTrustSnapshot>;
  decide(requestId: string, decision: CloudDeviceTrustDecision): Promise<CloudDeviceTrustSnapshot>;
  revoke(pinId: string, input: CloudDeviceTrustRevoke): Promise<CloudDeviceTrustSnapshot>;
};

export function createDeviceTrustStore(client: DeviceTrustStoreClient) {
  const snapshot = ref<DeviceTrustViewSnapshot>({ ...EMPTY_DEVICE_TRUST_SNAPSHOT });
  const loading = ref(false);
  const error = ref("");
  let generation = 0;
  let recovering: Promise<void> | undefined;
  let recoveryRequested = false;

  async function recover() {
    if (recovering) return recovering;
    const currentGeneration = generation;
    loading.value = true;
    let recovery: Promise<void>;
    recovery = (async () => {
      try {
        do {
          recoveryRequested = false;
          const next = await client.snapshot();
          if (generation !== currentGeneration) return;
          snapshot.value = applyDeviceTrustSnapshot(snapshot.value, next);
          error.value = "";
        } while (recoveryRequested);
      } catch (cause) {
        if (generation === currentGeneration) error.value = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      } finally {
        if (recovering === recovery) {
          loading.value = false;
          recovering = undefined;
          recoveryRequested = false;
        }
      }
    })();
    recovering = recovery;
    return recovery;
  }

  function applyEvent(payload: unknown) {
    if (!shouldRecoverDeviceTrust(snapshot.value, payload)) return;
    // A snapshot requested before this event can still resolve after it. Keep
    // a recovery marker so the store performs one more authoritative read
    // instead of silently staying behind the newest server revision.
    if (recovering) {
      recoveryRequested = true;
      return;
    }
    void recover().catch(() => undefined);
  }

  async function decide(requestId: string, decision: CloudDeviceTrustDecision) {
    const next = await client.decide(requestId, decision);
    snapshot.value = applyDeviceTrustSnapshot(snapshot.value, next);
    return next;
  }

  async function revoke(pinId: string, input: CloudDeviceTrustRevoke) {
    const next = await client.revoke(pinId, input);
    snapshot.value = applyDeviceTrustSnapshot(snapshot.value, next);
    return next;
  }

  function applySnapshot(next: CloudDeviceTrustSnapshot) {
    snapshot.value = applyDeviceTrustSnapshot(snapshot.value, next);
  }

  function reset() {
    generation += 1;
    recovering = undefined;
    recoveryRequested = false;
    loading.value = false;
    error.value = "";
    snapshot.value = { ...EMPTY_DEVICE_TRUST_SNAPSHOT };
  }

  return { snapshot, loading, error, recover, applyEvent, decide, revoke, applySnapshot, reset };
}
