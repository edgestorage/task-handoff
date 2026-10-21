import type { ModelProtocol } from "@task-handoff/protocol/control-plane";

export const IMAGE_OMITTED_PLACEHOLDER = "[image omitted by model relay]";

export type ImagePruningResult = {
  json: unknown;
  totalImages: number;
  retainedImages: number;
  removedImages: number;
  changed: boolean;
};

export class ImagePruningBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePruningBodyError";
  }
}

type JsonObject = Record<string, unknown>;
type ImageReference = { parent: unknown[]; index: number };

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectArray(value: unknown, field: string): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ImagePruningBodyError(`${field} must be an array.`);
  return value.filter(isObject);
}

function contentArray(value: unknown, field: string): unknown[] | undefined {
  if (value === undefined || typeof value === "string") return undefined;
  if (!Array.isArray(value)) throw new ImagePruningBodyError(`${field} must be a string or array.`);
  return value;
}

function collectContentImages(content: unknown[], type: string, references: ImageReference[]) {
  for (let index = 0; index < content.length; index += 1) {
    const item = content[index];
    if (isObject(item) && item.type === type) references.push({ parent: content, index });
  }
}

function collectChatCompletionsImages(root: JsonObject, references: ImageReference[]) {
  const messages = objectArray(root.messages, "messages");
  for (const message of messages) {
    const content = contentArray(message.content, "message.content");
    if (content) collectContentImages(content, "image_url", references);
  }
}

function collectResponsesImages(root: JsonObject, references: ImageReference[]) {
  if (root.input === undefined || typeof root.input === "string") return;
  if (!Array.isArray(root.input)) throw new ImagePruningBodyError("input must be a string or array.");
  for (const item of root.input) {
    if (!isObject(item)) continue;
    const content = contentArray(item.content, "input.content");
    if (content) collectContentImages(content, "input_image", references);
  }
}

function collectAnthropicContentImages(content: unknown[], references: ImageReference[]) {
  for (let index = 0; index < content.length; index += 1) {
    const item = content[index];
    if (!isObject(item)) continue;
    if (item.type === "image") {
      references.push({ parent: content, index });
      continue;
    }
    if (item.type === "tool_result") {
      const toolContent = contentArray(item.content, "tool_result.content");
      if (toolContent) collectAnthropicContentImages(toolContent, references);
    }
  }
}

function collectAnthropicMessagesImages(root: JsonObject, references: ImageReference[]) {
  const messages = objectArray(root.messages, "messages");
  for (const message of messages) {
    const content = contentArray(message.content, "message.content");
    if (content) collectAnthropicContentImages(content, references);
  }
}

function collectImages(protocol: ModelProtocol, root: JsonObject): ImageReference[] {
  const references: ImageReference[] = [];
  if (protocol === "openai-chat-completions") collectChatCompletionsImages(root, references);
  else if (protocol === "openai-responses") collectResponsesImages(root, references);
  else collectAnthropicMessagesImages(root, references);
  return references;
}

function placeholder(protocol: ModelProtocol): JsonObject {
  return {
    type: protocol === "openai-responses" ? "input_text" : "text",
    text: IMAGE_OMITTED_PLACEHOLDER,
  };
}

function removeImages(protocol: ModelProtocol, references: ImageReference[]) {
  const byParent = new Map<unknown[], number[]>();
  for (const reference of references) {
    const indexes = byParent.get(reference.parent);
    if (indexes) indexes.push(reference.index);
    else byParent.set(reference.parent, [reference.index]);
  }
  for (const [parent, indexes] of byParent) {
    for (const index of indexes.sort((left, right) => right - left)) parent.splice(index, 1);
    if (parent.length === 0) parent.push(placeholder(protocol));
  }
}

/**
 * Prune protocol-recognized image parts from a parsed request. This function
 * never decodes image data or follows image URLs; it only mutates the known
 * content arrays and replaces an emptied container with a text placeholder.
 */
export function pruneModelRelayImages(
  protocol: ModelProtocol,
  body: unknown,
  keepLatestImages: number,
): ImagePruningResult {
  if (!isObject(body)) throw new ImagePruningBodyError("The request body must be a JSON object.");
  const references = collectImages(protocol, body);
  const removedImages = Math.max(0, references.length - keepLatestImages);
  if (removedImages > 0) removeImages(protocol, references.slice(0, removedImages));
  return {
    json: body,
    totalImages: references.length,
    retainedImages: references.length - removedImages,
    removedImages,
    changed: removedImages > 0,
  };
}
