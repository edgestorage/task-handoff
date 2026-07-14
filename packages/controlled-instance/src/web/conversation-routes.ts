import type { FastifyInstance } from "fastify";
import { ConversationStore, conversationIdParam } from "../conversations/store";
import type { WebEventBus } from "./events";

type ConversationRouteOptions = {
  conversations: ConversationStore;
  events: WebEventBus;
};

function errorCode(error: unknown, fallback: string) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function registerConversationRoutes(app: FastifyInstance, { conversations, events }: ConversationRouteOptions) {
  app.get("/api/conversations", async () => ({
    data: conversations.list(),
  }));

  app.post<{ Body: Record<string, unknown> }>("/api/conversations", async (request, reply) => {
    try {
      const conversation = conversations.create(request.body || {});
      events.publish("conversation.created", conversation);
      return { data: conversation };
    } catch (error: unknown) {
      const code = errorCode(error, "CONVERSATION_CREATE_FAILED");
      return reply.code(code === "CONVERSATION_EXISTS" ? 409 : 400).send({ error: { code, message: errorMessage(error) } });
    }
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    try {
      const conversation = conversations.get(conversationIdParam(request.params.id));
      if (!conversation) {
        return reply.code(404).send({ error: { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found." } });
      }
      return { data: conversation };
    } catch (error: unknown) {
      const code = errorCode(error, "CONVERSATION_GET_FAILED");
      return reply.code(code === "CONVERSATION_ID_INVALID" ? 400 : 404).send({ error: { code, message: errorMessage(error) } });
    }
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/conversations/:id", async (request, reply) => {
    try {
      const conversation = conversations.update(conversationIdParam(request.params.id), request.body || {});
      events.publish("conversation.updated", conversation);
      return { data: conversation };
    } catch (error: unknown) {
      const code = errorCode(error, "CONVERSATION_UPDATE_FAILED");
      return reply.code(code === "CONVERSATION_NOT_FOUND" ? 404 : 400).send({ error: { code, message: errorMessage(error) } });
    }
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/use", async (request, reply) => {
    try {
      const conversation = conversations.use(conversationIdParam(request.params.id));
      events.publish("conversation.default.updated", conversation);
      return { data: conversation };
    } catch (error: unknown) {
      const code = errorCode(error, "CONVERSATION_USE_FAILED");
      return reply.code(code === "CONVERSATION_NOT_FOUND" ? 404 : 400).send({ error: { code, message: errorMessage(error) } });
    }
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/close", async (request, reply) => {
    try {
      const conversation = conversations.close(conversationIdParam(request.params.id));
      events.publish("conversation.closed", conversation);
      return { data: conversation };
    } catch (error: unknown) {
      const code = errorCode(error, "CONVERSATION_CLOSE_FAILED");
      return reply.code(code === "CONVERSATION_NOT_FOUND" ? 404 : 400).send({ error: { code, message: errorMessage(error) } });
    }
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/reopen", async (request, reply) => {
    try {
      const conversation = conversations.reopen(conversationIdParam(request.params.id));
      events.publish("conversation.reopened", conversation);
      return { data: conversation };
    } catch (error: unknown) {
      const code = errorCode(error, "CONVERSATION_REOPEN_FAILED");
      return reply.code(code === "CONVERSATION_NOT_FOUND" ? 404 : 400).send({ error: { code, message: errorMessage(error) } });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (request, reply) => {
    try {
      const conversation = conversations.delete(conversationIdParam(request.params.id));
      events.publish("conversation.deleted", conversation);
      return { data: conversation };
    } catch (error: unknown) {
      const code = errorCode(error, "CONVERSATION_DELETE_FAILED");
      const statusCode = code === "CONVERSATION_NOT_FOUND" ? 404 : code === "CONVERSATION_DEFAULT" ? 409 : 400;
      return reply.code(statusCode).send({ error: { code, message: errorMessage(error) } });
    }
  });
}
