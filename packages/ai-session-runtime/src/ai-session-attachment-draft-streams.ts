import { once } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import {
  AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES,
  AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS,
  type AiSessionAttachmentDraft,
  type AiSessionAttachmentDraftStreamCreateInput,
} from "@task-handoff/protocol/ai-sessions";

type DraftStream = {
  source: PassThrough;
  creation: Promise<AiSessionAttachmentDraft>;
  failurePromise: Promise<unknown>;
  failure?: unknown;
  phase: "open" | "appending" | "completing";
  declaredSize: number;
  written: number;
  timer: ReturnType<typeof setTimeout>;
};

function streamError(code: string, message: string, statusCode: number) {
  return Object.assign(new Error(message), { code, statusCode });
}

export class AiSessionAttachmentDraftStreams {
  private readonly streams = new Map<string, DraftStream>();
  private readonly createDraft: (
    input: Omit<AiSessionAttachmentDraftStreamCreateInput, "attachmentId"> & { id: string; source: Readable },
  ) => Promise<AiSessionAttachmentDraft>;

  constructor(
    createDraft: (
      input: Omit<AiSessionAttachmentDraftStreamCreateInput, "attachmentId"> & { id: string; source: Readable },
    ) => Promise<AiSessionAttachmentDraft>,
  ) {
    this.createDraft = createDraft;
  }

  async begin(input: AiSessionAttachmentDraftStreamCreateInput) {
    if (this.streams.has(input.attachmentId)) {
      throw streamError("AI_SESSION_ATTACHMENT_UPLOAD_EXISTS", "AI session attachment upload already exists.", 409);
    }
    const source = new PassThrough({ highWaterMark: AI_SESSION_ATTACHMENT_DRAFT_STREAM_CHUNK_BYTES });
    source.on("error", () => undefined);
    const { attachmentId, ...draft } = input;
    const creation = this.createDraft({ id: attachmentId, ...draft, source });
    const timer = setTimeout(() => this.destroy(attachmentId, new Error("AI session attachment upload expired.")), AI_SESSION_ATTACHMENT_DRAFT_STREAM_TTL_MS);
    timer.unref?.();
    const stream: DraftStream = {
      source,
      creation,
      failurePromise: Promise.resolve(undefined),
      phase: "open",
      declaredSize: input.size,
      written: 0,
      timer,
    };
    stream.failurePromise = creation.then(
      () => undefined,
      (error) => {
        this.markFailed(stream, error);
        return error;
      },
    );
    this.streams.set(attachmentId, stream);
    const early = await Promise.race([
      stream.failurePromise.then((error) => ({ error })),
      new Promise<{ ready: true }>((resolve) => setImmediate(() => resolve({ ready: true }))),
    ]);
    if ("error" in early && early.error !== undefined) {
      this.remove(attachmentId);
      throw early.error;
    }
    return { attachmentId, offset: 0 };
  }

  async append(attachmentId: string, offset: number, body: AsyncIterable<unknown>) {
    const stream = this.require(attachmentId);
    this.throwFailure(stream);
    if (stream.phase !== "open") {
      throw streamError("AI_SESSION_ATTACHMENT_UPLOAD_BUSY", "AI session attachment upload already has an operation in progress.", 409);
    }
    if (offset !== stream.written) {
      throw streamError("AI_SESSION_ATTACHMENT_OFFSET_MISMATCH", "AI session attachment upload offset does not match.", 409);
    }
    stream.phase = "appending";
    try {
      for await (const raw of body) {
        this.throwFailure(stream);
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        const nextOffset = stream.written + chunk.length;
        if (nextOffset > stream.declaredSize) {
          const error = streamError("AI_SESSION_ATTACHMENT_SIZE_MISMATCH", "Attachment content exceeded its declared size.", 400);
          this.markFailed(stream, error);
          throw error;
        }
        const writable = stream.source.write(chunk);
        stream.written = nextOffset;
        if (!writable) {
          const outcome = await Promise.race([
            once(stream.source, "drain").then(() => undefined),
            stream.failurePromise,
          ]);
          if (outcome !== undefined) throw outcome;
        }
      }
      await Promise.resolve();
      this.throwFailure(stream);
      return { attachmentId, offset: stream.written };
    } finally {
      if (this.streams.get(attachmentId) === stream && stream.phase === "appending") stream.phase = "open";
    }
  }

  async complete(attachmentId: string) {
    const stream = this.require(attachmentId);
    if (stream.failure !== undefined) {
      this.remove(attachmentId);
      throw stream.failure;
    }
    if (stream.phase !== "open") {
      throw streamError("AI_SESSION_ATTACHMENT_UPLOAD_BUSY", "AI session attachment upload already has an operation in progress.", 409);
    }
    stream.phase = "completing";
    this.remove(attachmentId);
    stream.source.end();
    return stream.creation;
  }

  cancel(attachmentId: string) {
    const stream = this.require(attachmentId);
    this.remove(attachmentId);
    stream.source.destroy(new Error("AI session attachment upload canceled."));
    return { removed: true as const };
  }

  dispose() {
    for (const attachmentId of [...this.streams.keys()]) {
      this.destroy(attachmentId, new Error("Controlled instance is closing."));
    }
  }

  private require(attachmentId: string) {
    const stream = this.streams.get(attachmentId);
    if (!stream) throw streamError("AI_SESSION_ATTACHMENT_UPLOAD_NOT_FOUND", "AI session attachment upload not found.", 404);
    return stream;
  }

  private remove(attachmentId: string) {
    const stream = this.streams.get(attachmentId);
    if (!stream) return;
    this.streams.delete(attachmentId);
    clearTimeout(stream.timer);
  }

  private destroy(attachmentId: string, error: Error) {
    const stream = this.streams.get(attachmentId);
    if (!stream) return;
    this.remove(attachmentId);
    stream.source.destroy(error);
  }

  private markFailed(stream: DraftStream, error: unknown) {
    if (stream.failure !== undefined) return;
    stream.failure = error;
    if (!stream.source.destroyed) stream.source.destroy(error instanceof Error ? error : new Error(String(error)));
  }

  private throwFailure(stream: DraftStream) {
    if (stream.failure !== undefined) throw stream.failure;
  }
}
