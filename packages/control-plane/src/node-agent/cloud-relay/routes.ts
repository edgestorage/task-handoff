import type { FastifyInstance } from "fastify";
import { NodeAgentCloudRelayBindRequestSchema } from "@task-handoff/protocol/control-plane";
import type { NodeAgentCloudRelayClient } from "./client.ts";

type Options = {
  client: NodeAgentCloudRelayClient;
};

/**
 * Local control surface for the account binding: the CLI (and the installer's
 * post-install step) binds, inspects and unbinds only through these routes, so
 * credentials and relay keys never appear in argv, logs or the status output.
 */
export function registerNodeAgentCloudRelayRoutes(app: FastifyInstance, options: Options) {
  app.get("/api/node-agent/cloud-relay", async () => ({ data: options.client.status() }));

  app.post("/api/node-agent/cloud-relay/bind", async (request, reply) => {
    const input = NodeAgentCloudRelayBindRequestSchema.parse(request.body ?? {});
    const status = await options.client.bind({
      cloudOrigin: input.cloudOrigin,
      bindingToken: input.bindingToken,
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    return reply.code(201).send({ data: status });
  });

  app.delete("/api/node-agent/cloud-relay", async () => ({ data: await options.client.unbind() }));
}
