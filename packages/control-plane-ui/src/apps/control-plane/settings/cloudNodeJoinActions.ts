import { deleteNode, releaseCloudAccountNodeClaim } from "../../../api/queries";

function apiErrorCode(error: unknown) {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
}

/** Cancel an account-node join and remove the local projection it may have created. */
export async function cancelCloudNodeJoin(input: { nodeHandle: string; nodeId?: string }) {
  await releaseCloudAccountNodeClaim(input.nodeHandle);
  if (!input.nodeId) return;
  try {
    await deleteNode(input.nodeId);
  } catch (error) {
    if (apiErrorCode(error) !== "NODE_NOT_FOUND") throw error;
  }
}
