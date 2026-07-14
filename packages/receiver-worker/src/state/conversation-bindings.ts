import type { BindingIdentity, BindingSection } from "./binding-identities";
import {
  claudeIdFromIdentities,
  codexIdFromIdentities,
  identitiesFromMessage,
} from "./binding-identities";

type LegacyBindingSection = BindingSection | "cwd" | "parentPids";
type BindingPatch = Record<BindingSection, Record<string, string | undefined>> &
  Partial<Record<"cwd" | "parentPids", Record<string, string | undefined>>>;
type SettingsWithBindings = {
  conversationBindings?: Partial<Record<LegacyBindingSection, Record<string, number | string | undefined>>>;
};

function parseConversationId(value: unknown) {
  const id = Number(String(value || "").trim());
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function emptyBindingPatch(): BindingPatch {
  return { sessions: {} };
}

function buildConversationBindingPatchFromIdentities(identities: BindingIdentity[], conversationId: number) {
  const conversationBindings = emptyBindingPatch();
  for (const identity of identities) {
    conversationBindings[identity.section][identity.key] = String(conversationId);
  }
  return { conversationBindings };
}

function buildConversationBindingPatch(message: Record<string, unknown>, conversationId: number) {
  return buildConversationBindingPatchFromIdentities(identitiesFromMessage(message), conversationId);
}

function buildSessionConversationBindingPatch(message: Record<string, unknown>, conversationId: number) {
  return buildConversationBindingPatchFromIdentities(
    identitiesFromMessage(message).filter((identity) => identity.section === "sessions"),
    conversationId,
  );
}

function conversationIdForIdentities(settings: SettingsWithBindings, identities: BindingIdentity[]) {
  const bindings = settings.conversationBindings || {};
  for (const identity of identities) {
    const conversationId = parseConversationId(bindings[identity.section]?.[identity.key]);
    if (conversationId) {
      return conversationId;
    }
  }
  return undefined;
}

function deleteConversationBindingPatch(settings: SettingsWithBindings, conversationId: number) {
  const bindings = settings.conversationBindings || {};
  const conversationBindings = emptyBindingPatch();
  for (const section of ["sessions", "cwd", "parentPids"] as LegacyBindingSection[]) {
    for (const [key, value] of Object.entries(bindings[section] || {})) {
      if (parseConversationId(value) === conversationId) {
        conversationBindings[section] ||= {};
        conversationBindings[section][key] = undefined;
      }
    }
  }
  return { conversationBindings };
}

function codexIdFromMessage(message: Record<string, unknown>) {
  return codexIdFromIdentities(identitiesFromMessage(message));
}

function claudeIdFromMessage(message: Record<string, unknown>) {
  return claudeIdFromIdentities(identitiesFromMessage(message));
}

export {
  buildConversationBindingPatch,
  buildConversationBindingPatchFromIdentities,
  buildSessionConversationBindingPatch,
  claudeIdFromMessage,
  codexIdFromMessage,
  conversationIdForIdentities,
  deleteConversationBindingPatch,
  parseConversationId,
};
