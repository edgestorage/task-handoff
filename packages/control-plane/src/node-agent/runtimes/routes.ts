import type { FastifyInstance } from "fastify";
import {
  CreateLocalFolderSchema,
  CreateNodeRuntimeSchema,
  FolderTreeQuerySchema,
  UpdateNodeRuntimeSchema,
} from "../schemas.ts";

type RuntimeRouteOperations = {
  listRuntimes(): unknown;
  createRuntime(input: ReturnType<typeof CreateNodeRuntimeSchema.parse>): unknown;
  updateRuntime(id: string, input: ReturnType<typeof UpdateNodeRuntimeSchema.parse>): unknown;
  deleteRuntime(id: string): unknown;
  checkRuntime(id: string): Promise<unknown>;
  listLocalFolders(): unknown;
  listFolderPlaces(): unknown;
  listFolderTree(input: ReturnType<typeof FolderTreeQuerySchema.parse>): unknown;
  createLocalFolder(input: ReturnType<typeof CreateLocalFolderSchema.parse>): unknown;
  deleteLocalFolder(id: string): unknown;
};

export function registerRuntimeRoutes(app: FastifyInstance, operations: RuntimeRouteOperations) {
  app.get("/api/node-agent/runtimes", async () => ({ data: operations.listRuntimes() }));
  app.post("/api/node-agent/runtimes", async (request, reply) => reply.code(201).send({
    data: operations.createRuntime(CreateNodeRuntimeSchema.parse(request.body)),
  }));
  app.patch("/api/node-agent/runtimes/:id", async (request) => ({
    data: operations.updateRuntime((request.params as { id: string }).id, UpdateNodeRuntimeSchema.parse(request.body)),
  }));
  app.delete("/api/node-agent/runtimes/:id", async (request) => ({
    data: { deleted: operations.deleteRuntime((request.params as { id: string }).id) },
  }));
  app.post("/api/node-agent/runtimes/:id/check", async (request) => ({
    data: await operations.checkRuntime((request.params as { id: string }).id),
  }));

  app.get("/api/node-agent/local-folders", async () => ({ data: operations.listLocalFolders() }));
  app.get("/api/node-agent/folders/places", async () => ({ data: operations.listFolderPlaces() }));
  app.get("/api/node-agent/folders/tree", async (request) => ({
    data: operations.listFolderTree(FolderTreeQuerySchema.parse(request.query)),
  }));
  app.post("/api/node-agent/local-folders", async (request, reply) => reply.code(201).send({
    data: operations.createLocalFolder(CreateLocalFolderSchema.parse(request.body)),
  }));
  app.delete("/api/node-agent/local-folders/:id", async (request) => ({
    data: { deleted: operations.deleteLocalFolder((request.params as { id: string }).id) },
  }));
}
