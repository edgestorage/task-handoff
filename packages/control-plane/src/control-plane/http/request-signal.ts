import type { FastifyReply, FastifyRequest } from "fastify";

export async function withRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  run: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnPrematureClose = () => {
    if (!reply.raw.writableEnded) abort();
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abortOnPrematureClose);
  try {
    return await run(controller.signal);
  } finally {
    request.raw.off("aborted", abort);
    reply.raw.off("close", abortOnPrematureClose);
  }
}
