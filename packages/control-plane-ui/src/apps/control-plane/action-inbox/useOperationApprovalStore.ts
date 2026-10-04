import { ref } from "vue";
import type { ApprovalSnapshot } from "@task-handoff/protocol/operation-approvals";
import { sharedControlPlaneClient } from "../../../api/sharedClient";
import { applyOperationApprovalEvent, applyOperationApprovalSnapshot } from "./operationApprovalState";

export function useOperationApprovalStore() {
  const snapshot = ref<ApprovalSnapshot>({ revision: -1, requests: [] });
  let generation = 0;
  async function recover() {
    const currentGeneration = generation;
    const next = await sharedControlPlaneClient.approvals.snapshot();
    if (generation === currentGeneration) snapshot.value = applyOperationApprovalSnapshot(snapshot.value, next);
  }
  function applyEvent(payload: unknown) {
    snapshot.value = applyOperationApprovalEvent(snapshot.value, payload);
  }
  function reset() {
    generation += 1;
    snapshot.value = { revision: -1, requests: [] };
  }
  return { snapshot, recover, applyEvent, reset };
}
