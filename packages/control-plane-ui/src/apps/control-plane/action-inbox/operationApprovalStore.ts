import { ref } from "vue";
import { ApprovalChangedEventSchema, type ApprovalSnapshot } from "@task-handoff/protocol/operation-approvals";
import {
  applyOperationApprovalEvent,
  applyOperationApprovalSnapshot,
} from "./operationApprovalState.ts";

export type OperationApprovalStoreClient = {
  snapshot(): Promise<ApprovalSnapshot>;
};

const EMPTY_APPROVAL_SNAPSHOT: ApprovalSnapshot = { generation: "", revision: -1, requests: [] };

export function createOperationApprovalStore(client: OperationApprovalStoreClient) {
  const snapshot = ref<ApprovalSnapshot>({ ...EMPTY_APPROVAL_SNAPSHOT });
  let requestEpoch = 0;
  let recovery: Promise<void> | undefined;
  let recoveryRequested = false;
  let expectedGeneration = "";

  async function recover() {
    if (recovery) return recovery;
    const currentEpoch = requestEpoch;
    let currentRecovery: Promise<void>;
    currentRecovery = (async () => {
      try {
        let generationRecoveryAttempts = 0;
        do {
          recoveryRequested = false;
          const next = await client.snapshot();
          if (requestEpoch !== currentEpoch) return;
          if (expectedGeneration && next.generation !== expectedGeneration) {
            if (generationRecoveryAttempts < 1) {
              generationRecoveryAttempts += 1;
              recoveryRequested = true;
              continue;
            }
            // A second restart happened while recovery was in flight. Accept
            // the newest authoritative snapshot instead of retrying forever.
            expectedGeneration = "";
          }
          snapshot.value = applyOperationApprovalSnapshot(snapshot.value, next);
          if (next.generation === expectedGeneration) expectedGeneration = "";
        } while (recoveryRequested);
      } finally {
        if (recovery === currentRecovery) {
          recovery = undefined;
          if (requestEpoch === currentEpoch && recoveryRequested) {
            recoveryRequested = false;
            void recover().catch(() => undefined);
          }
        }
      }
    })();
    recovery = currentRecovery;
    return currentRecovery;
  }

  function applyEvent(payload: unknown) {
    const parsed = ApprovalChangedEventSchema.safeParse(payload);
    if (!parsed.success) return;
    const generationChanged = snapshot.value.generation !== ""
      && parsed.data.generation !== snapshot.value.generation;
    const needsInitialSnapshot = snapshot.value.generation === "";
    if (generationChanged || needsInitialSnapshot) expectedGeneration = parsed.data.generation;
    snapshot.value = generationChanged
      ? applyOperationApprovalEvent({ generation: parsed.data.generation, revision: -1, requests: [] }, parsed.data)
      : applyOperationApprovalEvent(snapshot.value, parsed.data);
    if (generationChanged || needsInitialSnapshot) {
      if (recovery) recoveryRequested = true;
      else void recover().catch(() => undefined);
    }
  }

  function reset() {
    requestEpoch += 1;
    expectedGeneration = "";
    recovery = undefined;
    recoveryRequested = false;
    snapshot.value = { ...EMPTY_APPROVAL_SNAPSHOT };
  }

  return { snapshot, recover, applyEvent, reset };
}
