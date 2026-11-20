// Shared AST extractor for current-source contracts and pinned release snapshots.
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function normalizedPath(value) {
  return value
    .replace(/\{\*rest\}/g, "*")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/:[^/]+/g, "{}");
}

function sourceFiles(directory) {
  const files = [];
  const visit = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(child);
    }
  };
  visit(directory);
  return files;
}

function staticRoutePaths(expression, sourceFile) {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (!ts.isTemplateExpression(expression) || expression.templateSpans.length !== 1) return [];
  const span = expression.templateSpans[0];
  if (span.expression.getText(sourceFile) === "segment" && expression.head.text === "/api/") {
    return ["ai-sessions", "apps/sessions"].map((segment) => `${expression.head.text}${segment}${span.literal.text}`);
  }
  if (span.expression.getText(sourceFile) !== "base") return [];
  return [
    `/api/ai-sessions/:id/repository${expression.head.text}${span.literal.text}`,
    `/api/apps/sessions/:id/repository${expression.head.text}${span.literal.text}`,
  ];
}

function objectProperty(object, name, sourceFile) {
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const propertyName = property.name.getText(sourceFile).replace(/^['"]|['"]$/g, "");
    if (propertyName !== name) continue;
    return ts.isPropertyAssignment(property) ? property.initializer : property.name;
  }
  return undefined;
}

function isWebSocketOptions(object, sourceFile) {
  const websocket = objectProperty(object, "websocket", sourceFile);
  return Boolean(
    (websocket && websocket.kind === ts.SyntaxKind.TrueKeyword)
      || objectProperty(object, "wsHandler", sourceFile),
  );
}

function collectMethodVariables(sourceFile) {
  const methodVariables = new Map();
  const visit = (node) => {
    if (ts.isForOfStatement(node)
      && ts.isVariableDeclarationList(node.initializer)
      && node.initializer.declarations.length === 1) {
      const declaration = node.initializer.declarations[0];
      let values = node.expression;
      while (ts.isAsExpression(values) || ts.isParenthesizedExpression(values)) values = values.expression;
      if (ts.isIdentifier(declaration.name) && ts.isArrayLiteralExpression(values)) {
        methodVariables.set(
          declaration.name.text,
          values.elements.filter(ts.isStringLiteral).map((entry) => entry.text.toUpperCase()),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return methodVariables;
}

function resolveMethods(expression, methodVariables) {
  if (ts.isIdentifier(expression) && methodVariables.has(expression.text)) return methodVariables.get(expression.text);
  if (ts.isStringLiteral(expression)) return [expression.text.toUpperCase()];
  if (!ts.isArrayLiteralExpression(expression)) return undefined;
  if (!expression.elements.every(ts.isStringLiteral)) return undefined;
  return expression.elements.map((entry) => entry.text.toUpperCase());
}

function addRoute(routes, method, routePath, websocket, origin) {
  const normalized = normalizedPath(routePath);
  const key = `${method} ${normalized}`;
  const previous = routes.get(key);
  routes.set(key, {
    method,
    path: normalized,
    websocket: websocket || Boolean(previous?.websocket),
    origin,
  });
}

function nodeRouteSurface(root, sources) {
  const routes = new Map();
  const unresolved = [];
  const upgradeListeners = [];
  const sourceRoot = path.join(root, "packages", "controlled-instance", "src");
  const inputs = sources ?? sourceFiles(sourceRoot).map((file) => ({
    file: path.relative(root, file),
    source: fs.readFileSync(file, "utf8"),
  }));

  for (const { file: relativeFile, source } of inputs) {
    const sourceFile = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const methodVariables = collectMethodVariables(sourceFile);

    const recordUnresolved = (node, detail) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      unresolved.push(`${relativeFile}:${line} ${detail}`);
    };

    const visit = (node) => {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && (node.expression.expression.text === "app"
          || (relativeFile.endsWith("/repository/routes.ts") && node.expression.expression.text === "contentRoutes"))) {
        const methodName = node.expression.name.text;

        if (["get", "post", "put", "patch", "delete", "all"].includes(methodName)) {
          if (node.arguments.length === 0) {
            recordUnresolved(node, `app.${methodName}() has no path`);
          } else {
            const paths = staticRoutePaths(node.arguments[0], sourceFile);
            if (paths.length === 0) recordUnresolved(node, `app.${methodName}() has a non-static path`);
            const websocket = Boolean(node.arguments[1] && isWebSocketOptions(node.arguments[1], sourceFile));
            for (const routePath of paths) {
              addRoute(
                routes,
                methodName === "all" ? "ANY" : methodName.toUpperCase(),
                routePath,
                websocket,
                `${relativeFile}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`,
              );
            }
          }
        } else if (methodName === "route") {
          const route = node.arguments[0];
          if (!route || !ts.isObjectLiteralExpression(route)) {
            recordUnresolved(node, "app.route() registration is not an object literal");
          } else {
            const routePath = objectProperty(route, "url", sourceFile);
            const method = objectProperty(route, "method", sourceFile);
            const paths = routePath ? staticRoutePaths(routePath, sourceFile) : [];
            const methods = method ? resolveMethods(method, methodVariables) : undefined;
            if (paths.length === 0) recordUnresolved(node, "app.route() has a non-static url");
            if (!methods || methods.length === 0) recordUnresolved(node, "app.route() has an unresolved method set");
            const websocket = isWebSocketOptions(route, sourceFile);
            for (const pathValue of paths) {
              for (const routeMethod of methods || []) {
                addRoute(
                  routes,
                  routeMethod,
                  pathValue,
                  websocket,
                  `${relativeFile}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`,
                );
              }
            }
          }
        }
      }

      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "on"
        && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === "upgrade") {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        upgradeListeners.push(`${relativeFile}:${line}`);
        recordUnresolved(node, "direct server upgrade listener");
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { routes, unresolved, upgradeListeners };
}

module.exports = { nodeRouteSurface, normalizedPath };
