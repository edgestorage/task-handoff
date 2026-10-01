import fs from "node:fs";
import path from "node:path";
import { findLeaf, leavesForGroup } from "../contracts.ts";
import { ThctlError } from "../errors.ts";
import { exportContractDocument, renderContractJson, renderContractMarkdown } from "../schema-export.ts";
import type { CliContext, CliInvocation } from "../runtime.ts";

export async function schemaCommand(context: CliContext, invocation: CliInvocation) {
  const group = invocation.args.group?.trim();
  const leafName = invocation.args.leaf?.trim();
  const format = String(invocation.options.format ?? "json") === "md" ? "md" : "json";
  let target: { group?: string; leaf?: ReturnType<typeof findLeaf> } | undefined;
  if (!group && !leafName) {
    target = undefined;
  } else if (!leafName && findLeaf(group as string)) {
    target = { leaf: findLeaf(group as string) };
  } else if (!leafName && leavesForGroup(group as string).length) {
    target = { group };
  } else if (group && leafName) {
    const leaf = findLeaf(`${group} ${leafName}`);
    if (!leaf) throw new ThctlError("CLI_SCHEMA_TARGET_UNKNOWN", `No leaf command \`${group} ${leafName}\` is declared.`, 7, { group, leaf: leafName });
    target = { leaf };
  } else {
    throw new ThctlError("CLI_SCHEMA_TARGET_UNKNOWN", `No command group \`${group}\` is declared.`, 7, { group });
  }
  const document = exportContractDocument(target);
  const content = format === "md" ? renderContractMarkdown(document) : renderContractJson(document);
  const out = typeof invocation.options.out === "string" ? invocation.options.out.trim() : "";
  if (out) {
    const file = path.resolve(out);
    fs.writeFileSync(file, content, { mode: 0o644 });
    return { data: { out: file, format, commands: document.commands.length }, message: `Wrote ${document.commands.length} contracts to ${file}.` };
  }
  context.output.streams.stdout(content);
  return { data: undefined };
}
