import { sharedControlPlaneClient } from "../../../api/sharedClient";
import { createOperationApprovalStore } from "./operationApprovalStore.ts";

export { createOperationApprovalStore, type OperationApprovalStoreClient } from "./operationApprovalStore.ts";

export function useOperationApprovalStore() {
  return createOperationApprovalStore(sharedControlPlaneClient.approvals);
}
