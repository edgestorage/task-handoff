const TRUST_RETRY_UNSUPPORTED_CODES = new Set([
  "CLOUD_NODE_TRUST_RETRY_COORDINATOR_UNSUPPORTED",
  "CLOUD_NODE_TRUST_RETRY_NODE_AGENT_UNSUPPORTED",
  "CLOUD_NODE_TRUST_RETRY_NODE_AGENT_NOT_OBSERVED",
]);

type CloudAccountNodeConnectionOperations<T> = {
  reapply(): Promise<T>;
  claim(): Promise<T>;
};

export async function connectCloudAccountNodeWithTrustRetry<T>(
  operations: CloudAccountNodeConnectionOperations<T>,
): Promise<T> {
  try {
    return await operations.reapply();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    if (!TRUST_RETRY_UNSUPPORTED_CODES.has(code)) throw error;
    return await operations.claim();
  }
}
