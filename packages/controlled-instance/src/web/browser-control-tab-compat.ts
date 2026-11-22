import {
  supportsEmbeddedBrowserTabOrigin,
  type EmbeddedBrowserTabsOpenParams,
} from "@task-handoff/protocol/embedded-browser-control";

export function embeddedBrowserTabsOpenParamsForPeer(
  params: EmbeddedBrowserTabsOpenParams,
  peerProtocolVersion?: string,
): EmbeddedBrowserTabsOpenParams {
  if (supportsEmbeddedBrowserTabOrigin(peerProtocolVersion)) return params;
  // Compatibility for desktops before 2026-11-23: their strict tabs.open
  // schema rejects requesterSessionRef, so keep the legacy wire shape.
  const { requesterSessionRef: _requesterSessionRef, ...legacyParams } = params;
  return legacyParams;
}
