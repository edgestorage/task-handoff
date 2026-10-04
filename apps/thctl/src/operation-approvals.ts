import type { ApprovalWait } from "@task-handoff/protocol/operation-approvals";
import { CLI_EXIT_CODES, ThctlError } from "./errors.ts";
import type { ThctlConnection } from "./control-plane.ts";

export type ApprovalWaitContext = {
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
  notify?: (id: string) => void;
};

export async function guardApprovalProtocol<T>(connection: Pick<ThctlConnection, "client">, execute: () => Promise<T>): Promise<T> {
  try {
    await connection.client.approvals.support();
  } catch (error) {
    throw new ThctlError("CLI_APPROVAL_UNAVAILABLE", "Approval protocol is unavailable; the protected request was not sent.", CLI_EXIT_CODES.capability, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return execute();
}

export async function waitForOperationApproval(
  wait: ApprovalWait,
  context: ApprovalWaitContext,
  status: () => Promise<ApprovalWait>,
  cancel: () => Promise<unknown>,
): Promise<void> {
  const deadline = Date.parse(wait.expiresAt);
  if (!Number.isFinite(deadline)) throw new ThctlError("CLI_APPROVAL_INVALID", "The approval deadline is invalid.", CLI_EXIT_CODES.protocol);
  const expiresAt = Math.min(deadline, Date.now() + 5 * 60_000);
  context.notify?.(wait.id);
  try {
    for (;;) {
      if (context.signal.aborted) throw new ThctlError("CLI_CANCELLED", "The operation was cancelled.", CLI_EXIT_CODES.cancelled);
      if (Date.now() >= expiresAt) throw new ThctlError("CLI_APPROVAL_EXPIRED", "The approval expired without a decision.", CLI_EXIT_CODES.cancelled);
      const current = await status().catch((error: unknown) => {
        if (error instanceof ThctlError && error.code === "OPERATION_APPROVAL_NOT_FOUND") {
          throw new ThctlError("CLI_APPROVAL_EXPIRED", "The approval request expired or was cancelled.", CLI_EXIT_CODES.cancelled);
        }
        throw error;
      });
      if (current.status === "denied") throw new ThctlError("CLI_APPROVAL_DENIED", "The operation was denied.", CLI_EXIT_CODES.forbidden);
      if (current.status === "approved") break;
      await context.sleep(Math.min(1_000, Math.max(0, expiresAt - Date.now())));
    }
    if (context.signal.aborted) throw new ThctlError("CLI_CANCELLED", "The operation was cancelled.", CLI_EXIT_CODES.cancelled);
  } catch (error) {
    if (context.signal.aborted) await cancel().catch(() => undefined);
    throw error;
  }
}
