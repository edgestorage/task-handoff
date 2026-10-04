import { z } from "zod";
import { CLI_GROUPS, CLI_LEAVES, type CliGroup, type CliLeaf } from "./contracts.ts";
import { THCTL_VERSION } from "./client-info.ts";

export const CLI_CONTRACT_VERSION = "1";

export function leafUsage(leaf: CliLeaf) {
  const args = (leaf.args ?? []).map((arg) => arg.required ? `<${arg.name}>` : `[${arg.name}]`);
  return ["thctl", leaf.id, ...args].join(" ");
}

function leafDocument(leaf: CliLeaf) {
  return {
    id: leaf.id,
    group: leaf.group,
    summary: leaf.summary,
    stage: leaf.stage,
    implemented: Boolean(leaf.handler),
    write: Boolean(leaf.write),
    usage: leafUsage(leaf),
    arguments: (leaf.args ?? []).map((arg) => ({ ...arg, required: Boolean(arg.required), variadic: Boolean(arg.variadic) })),
    options: leaf.options ?? [],
    examples: leaf.examples ?? [],
    inputSchema: z.toJSONSchema(leaf.input, { io: "input", unrepresentable: "any" }),
    outputSchema: z.toJSONSchema(leaf.output, { io: "output", unrepresentable: "any" }),
    outputPinned: leaf.outputPinned !== false,
    outputMode: leaf.outputMode ?? "document",
  };
}

export function exportContractDocument(target?: { group?: string; leaf?: CliLeaf }) {
  const leaves = target?.leaf ? [target.leaf] : target?.group ? CLI_LEAVES.filter((leaf) => leaf.group === target.group) : CLI_LEAVES;
  const groups = (target?.leaf
    ? CLI_GROUPS.filter((entry) => entry.name === target.leaf?.group)
    : target?.group ? CLI_GROUPS.filter((entry) => entry.name === target.group) : CLI_GROUPS)
    .map((entry) => ({ name: entry.name, summary: entry.summary, flat: Boolean(entry.flat), leaves: entry.leaves.filter((leaf) => leaves.includes(leaf)).map((leaf) => leaf.id) }));
  return {
    cli: "thctl",
    version: THCTL_VERSION,
    contractVersion: CLI_CONTRACT_VERSION,
    globalOptions: [
      { flags: "--profile <label>", description: "Profile to use (overrides TASK_HANDOFF_CLI_PROFILE)" },
      { flags: "--json", description: "Emit machine-readable JSON on stdout" },
      { flags: "--yes", description: "Skip interactive confirmation for write commands" },
      { flags: "--dry-run", description: "Print the request a write command would send without sending it" },
      { flags: "--token-stdin", description: "Read a secret (token, join token, credential) from stdin instead of a flag" },
      { flags: "--no-update-check", description: "Skip the background CLI and skill update check" },
    ],
    groups: groups.map((entry) => ({ ...entry, leaves: entry.leaves })),
    commands: leaves.map(leafDocument),
  };
}

export type CliContractDocument = ReturnType<typeof exportContractDocument>;

function renderLeafMarkdown(leaf: ReturnType<typeof leafDocument>) {
  const lines: string[] = [];
  lines.push(`### \`${leaf.id}\``, "", leaf.summary, "");
  lines.push(`- stage: ${leaf.stage}`, `- implemented: ${leaf.implemented ? "yes" : "no"}`, `- write: ${leaf.write ? "yes" : "no"}`, `- usage: \`${leaf.usage}\``, "");
  if (leaf.arguments.length) {
    lines.push("| argument | required | description |", "| --- | --- | --- |");
    for (const arg of leaf.arguments) lines.push(`| \`${arg.name}\` | ${arg.required ? "yes" : "no"} | ${arg.description} |`);
    lines.push("");
  }
  if (leaf.options.length) {
    lines.push("| option | description |", "| --- | --- |");
    for (const option of leaf.options) lines.push(`| \`${option.flags}\` | ${option.description} |`);
    lines.push("");
  }
  if (leaf.examples.length) {
    lines.push("Examples:", "", ...leaf.examples.map((example) => `- \`${example}\``), "");
  }
  lines.push("Input JSON Schema:", "", "```json", JSON.stringify(leaf.inputSchema, null, 2), "```", "");
  lines.push("Output JSON Schema:", "", "```json", JSON.stringify(leaf.outputSchema, null, 2), "```", "");
  return lines.join("\n");
}

export function renderContractMarkdown(document: CliContractDocument) {
  const lines: string[] = [
    `# thctl contract (v${document.version}, contract ${document.contractVersion})`,
    "",
    "Global options:",
    "",
    ...document.globalOptions.map((option) => `- \`${option.flags}\` — ${option.description}`),
    "",
    "## Commands",
    "",
  ];
  for (const group of document.groups) {
    lines.push(`### ${group.name}`, "", group.summary, "");
    if (group.flat) {
      lines.push(...group.leaves.map((id) => `- \`${id}\``), "");
    } else {
      lines.push(`\`thctl ${group.name} <command>\``, "", ...group.leaves.map((id) => `- \`${id}\``), "");
    }
  }
  for (const leaf of document.commands) lines.push(renderLeafMarkdown(leaf), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderContractJson(document: CliContractDocument) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function contractTargets() {
  return { groups: CLI_GROUPS.map((entry: CliGroup) => entry.name), leaves: CLI_LEAVES.map((leaf) => leaf.id) };
}
