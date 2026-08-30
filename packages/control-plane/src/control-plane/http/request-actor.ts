import type { FastifyRequest } from "fastify";
import type { ControlPlaneActor } from "../auth/authorization.ts";

const actors = new WeakMap<FastifyRequest, ControlPlaneActor>();

export function setControlPlaneRequestActor(request: FastifyRequest, actor: ControlPlaneActor) {
  actors.set(request, actor);
}

export function controlPlaneRequestActor(request: FastifyRequest) {
  return actors.get(request);
}
