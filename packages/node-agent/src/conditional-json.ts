import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** Builds a strong validator from the exact JSON value a node-agent route serves. */
export function jsonResponseEtag(value: unknown) {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("base64url");
  return `"${digest}"`;
}

function normalizedEtag(value: string) {
  return value.trim().replace(/^W\//, "");
}

export function ifNoneMatchMatches(header: string | string[] | undefined, etag: string) {
  if (!header) return false;
  const values = Array.isArray(header) ? header : [header];
  const expected = normalizedEtag(etag);
  return values
    .flatMap((value) => value.split(","))
    .some((value) => value.trim() === "*" || normalizedEtag(value) === expected);
}

/** Serves a GET result with a 304 when the client already has this projection. */
export function conditionalJsonResponse(request: FastifyRequest, reply: FastifyReply, data: unknown) {
  const etag = jsonResponseEtag(data);
  reply.header("etag", etag).header("cache-control", "no-cache");
  if (ifNoneMatchMatches(request.headers["if-none-match"], etag)) return reply.code(304).send();
  return { data };
}
