import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const vueBuiltins = new Set([
  "Component",
  "KeepAlive",
  "Suspense",
  "Teleport",
  "Transition",
  "TransitionGroup",
]);

test("PascalCase components used by Vue templates are locally imported", () => {
  const missing = [];

  for (const file of vueFiles(sourceRoot)) {
    const source = fs.readFileSync(file, "utf8");
    const imports = importedBindings(file, source);
    const componentName = path.basename(file, ".vue");

    for (const tag of templateComponentTags(source)) {
      if (!imports.has(tag) && !vueBuiltins.has(tag) && tag !== componentName) {
        missing.push(`${path.relative(sourceRoot, file)}: ${tag}`);
      }
    }
  }

  assert.deepEqual(missing, []);
});

function vueFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return vueFiles(target);
    return entry.name.endsWith(".vue") ? [target] : [];
  });
}

function importedBindings(file, source) {
  const imports = new Set();
  const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .join("\n");
  const script = ts.createSourceFile(`${file}.ts`, scripts, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const statement of script.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name) imports.add(clause.name.text);
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      imports.add(clause.namedBindings.name.text);
      continue;
    }
    for (const element of clause.namedBindings.elements) imports.add(element.name.text);
  }

  return imports;
}

function templateComponentTags(source) {
  const templateStart = source.indexOf("<template");
  const templateEnd = source.lastIndexOf("</template>");
  if (templateStart < 0 || templateEnd < templateStart) return [];
  const contentStart = source.indexOf(">", templateStart) + 1;
  const template = source.slice(contentStart, templateEnd);
  return new Set([...template.matchAll(/<([A-Z][A-Za-z0-9_$]*)\b/g)].map((match) => match[1]));
}
