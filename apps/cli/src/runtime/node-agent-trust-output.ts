import { stripVTControlCharacters, styleText } from "node:util";
import type {
  NodeAgentControlPlaneTrustPin,
  NodeAgentControlPlaneTrustRequest,
  NodeAgentControlPlaneTrustSnapshot,
} from "@task-handoff/protocol/node-agent-control-plane-trust";

export type TrustDisplayNames = {
  nodeName?: string;
  controlPlanes: ReadonlyMap<string, string>;
};

type TrustOutputOptions = {
  names: TrustDisplayNames;
  verbose?: boolean;
  color?: boolean;
  columns?: number;
  /** Non-secret transport selectors, so copied commands address the same node. */
  transportArgs?: string[];
};

type TrustEntry = NodeAgentControlPlaneTrustRequest | NodeAgentControlPlaneTrustPin;

function terminalText(value: string) {
  // Names are remote display data, never terminal instructions or new rows.
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
}

function shortId(id: string, peers: readonly string[]) {
  // IDs are opaque: do not assume a prefix, length or encoding. Expand a suffix
  // until distinct rather than giving unrelated records the same abbreviated ID.
  const characters = Array.from(terminalText(id));
  for (let size = 6; size < characters.length; size++) {
    const suffix = characters.slice(-size).join("");
    if (peers.every((peer) => peer === id || !terminalText(peer).endsWith(suffix))) return `…${suffix}`;
  }
  return characters.join("");
}

function utcTime(value: string, verbose = false) {
  return verbose ? value : `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function reasonLabel(reason: NodeAgentControlPlaneTrustRequest["reason"]) {
  const labels: Record<NodeAgentControlPlaneTrustRequest["reason"], string> = {
    "first-seen": "First connection",
    "key-changed": "Key changed",
    "access-context-changed": "Access changed",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
  };
  return labels[reason];
}

function shellArgument(value: string) {
  return /^[a-zA-Z0-9_./:=,@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function trustCommand(action: "approve" | "revoke", entry: TrustEntry, transportArgs: string[], columns: number) {
  const id = "requestId" in entry ? entry.requestId : entry.pinId;
  const parts = [
    ["task-handoff-node-agent", "trust", action, id],
    ["--comparison-code", entry.comparisonCode, "--revision", String(entry.revision)],
    ...(transportArgs.length ? [transportArgs] : []),
  ];
  // Use POSIX quoting for opaque identifiers and transport paths. A terminal
  // control character cannot safely appear in a copyable shell command.
  if (parts.flat().some((part) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(part))) {
    return ["    Use the full ID and verification code from --json for this command."];
  }
  const lines = parts.map((part) => part.map(shellArgument).join(" "));
  const singleLine = `    ${lines.join(" ")}`;
  return singleLine.length <= columns
    ? [singleLine]
    : lines.map((line, index) => `    ${index ? "  " : ""}${line}${index < lines.length - 1 ? " \\" : ""}`);
}

export function renderTrustSnapshot(snapshot: NodeAgentControlPlaneTrustSnapshot, options: TrustOutputOptions) {
  const { names, verbose = false, color = false, columns = 80, transportArgs = [] } = options;
  const width = Math.max(20, columns);
  const rows: string[] = [];
  const paint = (format: "bold" | "yellow" | "green" | "cyan", text: string) => color
    ? styleText(format, text, { validateStream: false }) : text;
  const field = (label: string, value: string, highlight = false) => {
    const prefix = `  ${label.padEnd(14)}`;
    const text = terminalText(value);
    const displayed = highlight ? paint("cyan", text) : text;
    if (prefix.length + text.length > width) rows.push(prefix.trimEnd(), `    ${displayed}`);
    else rows.push(`${prefix}${displayed}`);
  };
  const pending = snapshot.requests.filter((entry) => entry.status === "pending");
  const active = snapshot.pins.filter((entry) => entry.status === "active");
  const controlPlaneIds = [...new Set([...pending, ...active].map((entry) => entry.controlPlaneId))];
  const displayNames = new Map(controlPlaneIds.map((id) => [id, terminalText(names.controlPlanes.get(id) || "")]));
  const title = (entry: TrustEntry, status: string) => {
    const id = entry.controlPlaneId;
    const name = displayNames.get(id);
    const duplicates = controlPlaneIds.filter((peer) => displayNames.get(peer) === name);
    const label = !name ? `Unnamed Control Plane (${shortId(id, controlPlaneIds)})`
      : duplicates.length > 1 ? `${name} (${shortId(id, duplicates)})` : name;
    const heading = `  ${label} · ${status}`;
    if (heading.length > width) rows.push(paint("bold", `  ${label}`), `  ${status}`);
    else rows.push(paint("bold", heading));
    rows.push("");
  };
  const details = (entry: TrustEntry) => {
    field("Control Plane", entry.controlPlaneId);
    field("Fingerprint", entry.fingerprint);
    field("Node handle", entry.nodeHandle);
    field("Binding", entry.bindingId);
    field("Binding rev", String(entry.bindingRevision));
    field("Account", entry.access.accountId);
    field("Owner", entry.access.ownerAccountId);
    if (entry.access.shareGrantId) field("Share grant", entry.access.shareGrantId);
    if (entry.access.shareRevision !== undefined) field("Share rev", String(entry.access.shareRevision));
    if (entry.access.shareRole) field("Share role", entry.access.shareRole);
    field("Revision", String(entry.revision));
  };
  const section = (label: string, count: number, format: "yellow" | "green") => {
    rows.push("", paint(format, `${label} · ${count}`), "─".repeat(Math.min(60, width)));
  };

  rows.push(paint("bold", "Control Plane Trust"));
  field("Node", terminalText(names.nodeName || "") || `Unnamed node (${shortId(snapshot.nodeId, [])})`);
  if (verbose) {
    field("Node ID", snapshot.nodeId);
    if (snapshot.nodeHandle) field("Node handle", snapshot.nodeHandle);
  }
  section("Pending", pending.length, "yellow");
  if (!pending.length) rows.push("  No pending requests");
  for (const entry of pending) {
    title(entry, reasonLabel(entry.reason));
    field("Verify code", entry.comparisonCode, true);
    field("Access", entry.access.accessMode === "shared" ? "Shared access" : "Owner");
    field("Expires", utcTime(entry.expiresAt, verbose));
    if (verbose) {
      details(entry);
      field("Request", entry.requestId);
      field("Requested", utcTime(entry.requestedAt, true));
      field("Last seen", utcTime(entry.lastSeenAt, true));
    }
    rows.push("", "  After comparing the code with the Control Plane, approve with:", ...trustCommand("approve", entry, transportArgs, width), "");
  }
  section("Trusted", active.length, "green");
  if (!active.length) rows.push("  No trusted Control Planes");
  for (const entry of active) {
    title(entry, "Trusted");
    field("Verify code", entry.comparisonCode, true);
    field("Access", entry.access.accessMode === "shared" ? "Shared access" : "Owner");
    field("Last seen", utcTime(entry.lastSeenAt, verbose));
    if (verbose) {
      details(entry);
      field("Pin", entry.pinId);
      field("Approved", utcTime(entry.approvedAt, true));
      field("Approved by", `${entry.approvedByActorType}:${entry.approvedByActorId}`);
      rows.push("", "  Revoke:", ...trustCommand("revoke", entry, transportArgs, width));
    }
    rows.push("");
  }
  if (!verbose) rows.push("", "Use --verbose for fingerprints, full IDs and revocation commands.");
  // Keep one empty line between records/sections, including empty states.
  return `${rows.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
