import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { compileTemplate, parse as parseSfc } from "vue/compiler-sfc";

// A legitimate visible product/protocol/code literal may suppress exactly one
// finding on the adjacent line:
// i18n-audit-allow-next-line <product-name|protocol-name|code-token>: reason

const ALLOW_CATEGORIES = new Set(["product-name", "protocol-name", "code-token"]);
const ALLOW_DIRECTIVE = "i18n-audit-allow-next-line";
const VISIBLE_ATTRIBUTES = new Set(["alt", "aria-label", "placeholder", "title"]);
const VISIBLE_FIELDS = new Set([
  "alt",
  "ariaLabel",
  "cancelText",
  "confirmText",
  "description",
  "emptyText",
  "helperText",
  "label",
  "placeholder",
  "title",
]);

function isVisibleText(value) {
  return /\p{L}/u.test(value.trim());
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function expressionStrings(expression) {
  const values = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push(node);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      if (isVisibleText(node.head.text)) values.push(node.head);
      for (const span of node.templateSpans) {
        if (isVisibleText(span.literal.text)) values.push(span.literal);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.whenTrue);
      visit(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node) || ts.isParenthesizedExpression(node) || ts.isArrayLiteralExpression(node)) {
      ts.forEachChild(node, visit);
    }
  };
  visit(expression);
  return values;
}

function callPath(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const owner = callPath(expression.expression);
    return owner ? `${owner}.${expression.name.text}` : undefined;
  }
  return undefined;
}

function isVisibleCall(expression) {
  const name = callPath(expression);
  return (
    name === "alert" ||
    name === "confirm" ||
    name === "window.alert" ||
    name === "window.confirm" ||
    name === "toast" ||
    name?.startsWith("toast.") ||
    /^(?:set|show)?(?:Error|Feedback|Notice|Warning|Toast)$/.test(name ?? "")
  );
}

function scriptKind(filename) {
  if (filename.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filename.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filename.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function scanScript(source, filename, lineOffset = 0) {
  const findings = [];
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filename),
  );
  const add = (node, kind, value = node.text) => {
    if (!isVisibleText(value)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file: filename,
      line: position.line + 1 + lineOffset,
      column: position.character + 1,
      kind,
      text: value.trim(),
    });
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && VISIBLE_FIELDS.has(propertyName(node.name))) {
      for (const value of expressionStrings(node.initializer)) add(value, "display-field");
    } else if (ts.isCallExpression(node) && isVisibleCall(node.expression)) {
      for (const argument of node.arguments) {
        for (const value of expressionStrings(argument)) add(value, "display-call");
      }
    } else if (ts.isJsxText(node)) {
      add(node, "jsx-text", node.getText(sourceFile));
    } else if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.text)) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        add(node.initializer, "visible-attribute");
      } else if (node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        for (const value of expressionStrings(node.initializer.expression)) add(value, "visible-attribute");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function scanTemplate(source, filename, lineOffset = 0, allowIndexScriptError = false) {
  const result = compileTemplate({ source, filename, id: "i18n-audit" });
  const findings = result.errors
    .filter((error) => !(allowIndexScriptError && typeof error === "object" && error?.code === 64))
    .map((error) => ({
      file: filename,
      line: (typeof error === "object" && error?.loc?.start?.line ? error.loc.start.line : 1) + lineOffset,
      column: typeof error === "object" && error?.loc?.start?.column ? error.loc.start.column : 1,
      kind: "parse-error",
      text: typeof error === "string" ? error : error.message,
    }));
  const add = (loc, kind, value) => {
    if (!isVisibleText(value)) return;
    findings.push({
      file: filename,
      line: loc.start.line + lineOffset,
      column: loc.start.column,
      kind,
      text: value.trim(),
    });
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === 2) add(node.loc, "template-text", node.content);
    if (node.type === 5) {
      const interpolationSource = node.content?.loc?.source ?? node.content?.content;
      const expression = ts.createSourceFile(
        "interpolation.ts",
        `(${interpolationSource ?? ""})`,
        ts.ScriptTarget.Latest,
        true,
      ).statements[0]?.expression;
      if (expression) {
        for (const value of expressionStrings(expression)) {
          add(node.content.loc, "template-interpolation", value.text);
        }
      }
    }
    if (node.type === 1) {
      for (const prop of node.props ?? []) {
        if (prop.type === 6 && VISIBLE_ATTRIBUTES.has(prop.name) && prop.value) {
          add(prop.value.loc, "visible-attribute", prop.value.content);
        }
        if (prop.type === 7 && prop.arg?.isStatic && VISIBLE_ATTRIBUTES.has(prop.arg.content) && prop.exp) {
          for (const value of expressionStrings(
            ts.createSourceFile("binding.ts", `(${prop.exp.content})`, ts.ScriptTarget.Latest, true).statements[0]
              .expression,
          )) {
            add(prop.loc, "visible-attribute", value.text);
          }
        }
      }
    }
    for (const child of node.children ?? []) walk(child);
    for (const branch of node.branches ?? []) walk(branch);
  };
  walk(result.ast);
  return findings;
}

function parseAllowDirectives(source, filename) {
  const directives = [];
  const malformed = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (!line.includes(ALLOW_DIRECTIVE)) return;
    const match = line.match(/i18n-audit-allow-next-line\s+([^\s:]+)\s*:\s*(.*?)\s*(?:-->|\*\/)?\s*$/);
    const lineNumber = index + 1;
    const category = match?.[1];
    const reason = match?.[2]?.replace(/\s*(?:-->|\*\/)\s*$/, "").trim();
    if (!match || !ALLOW_CATEGORIES.has(category) || !reason) {
      malformed.push({
        file: filename,
        line: lineNumber,
        column: Math.max(1, line.indexOf(ALLOW_DIRECTIVE) + 1),
        kind: "invalid-allow",
        text: `Use '${ALLOW_DIRECTIVE} <product-name|protocol-name|code-token>: reason'`,
      });
      return;
    }
    directives.push({ line: lineNumber, targetLine: lineNumber + 1, category, reason });
  });
  return { directives, malformed };
}

function applyAllowDirectives(source, filename, findings) {
  const { directives, malformed } = parseAllowDirectives(source, filename);
  const remaining = [...findings];
  const allowFindings = [...malformed];
  for (const directive of directives) {
    const matches = remaining.filter((finding) => finding.line === directive.targetLine);
    if (matches.length !== 1) {
      allowFindings.push({
        file: filename,
        line: directive.line,
        column: 1,
        kind: matches.length === 0 ? "stale-allow" : "broad-allow",
        text:
          matches.length === 0
            ? `Exception has no finding on adjacent line ${directive.targetLine}`
            : `Exception would hide ${matches.length} findings; split them onto separate lines`,
      });
      continue;
    }
    remaining.splice(remaining.indexOf(matches[0]), 1);
  }
  return [...remaining, ...allowFindings];
}

export function auditSource(source, filename) {
  let findings = [];
  if (filename.endsWith(".vue")) {
    const parsed = parseSfc(source, { filename });
    findings.push(
      ...parsed.errors.map((error) => ({
        file: filename,
        line: typeof error === "object" && error?.loc?.start?.line ? error.loc.start.line : 1,
        column: typeof error === "object" && error?.loc?.start?.column ? error.loc.start.column : 1,
        kind: "parse-error",
        text: typeof error === "string" ? error : error.message,
      })),
    );
    const { template, script, scriptSetup } = parsed.descriptor;
    if (template) findings.push(...scanTemplate(template.content, filename, template.loc.start.line - 1));
    if (script) findings.push(...scanScript(script.content, filename, script.loc.start.line - 1));
    if (scriptSetup) findings.push(...scanScript(scriptSetup.content, filename, scriptSetup.loc.start.line - 1));
  } else if (filename.endsWith(".html")) {
    findings = scanTemplate(source, filename, 0, true);
  } else {
    findings = scanScript(source, filename);
  }
  return applyAllowDirectives(source, filename, findings).sort(
    (left, right) => left.line - right.line || left.column - right.column,
  );
}

function collectFiles(entry, files) {
  const stats = fs.statSync(entry);
  if (stats.isDirectory()) {
    for (const name of fs.readdirSync(entry).sort()) {
      if (name === "locales") continue;
      collectFiles(path.join(entry, name), files);
    }
    return;
  }
  if (/\.(?:html|js|jsx|ts|tsx|vue)$/.test(entry) && !entry.endsWith(".d.ts")) files.push(entry);
}

export function auditPaths(entries) {
  const files = [];
  for (const entry of entries) collectFiles(entry, files);
  return files.flatMap((file) => auditSource(fs.readFileSync(file, "utf8"), file));
}

function runCli() {
  const root = process.cwd();
  const entries = process.argv.slice(2);
  const targets = entries.length ? entries.map((entry) => path.resolve(root, entry)) : [path.join(root, "src"), path.join(root, "index.html")];
  const findings = auditPaths(targets);
  if (!findings.length) {
    console.log(`i18n audit passed (${targets.length} target${targets.length === 1 ? "" : "s"})`);
    return;
  }
  for (const finding of findings) {
    const relative = path.relative(root, finding.file) || finding.file;
    console.error(`${relative}:${finding.line}:${finding.column} [${finding.kind}] ${JSON.stringify(finding.text)}`);
  }
  console.error(`i18n audit failed with ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runCli();
