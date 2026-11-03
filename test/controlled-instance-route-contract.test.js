const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "controlled-instance-rs", "crates", "instance", "src", "server.rs");
const matrixPath = path.join(root, "controlled-instance-rs", "docs", "http-route-matrix.md");

const BASELINE_HEADING = "## `v0.0.46` compatibility baseline";
const TARGET_HEADING = "## Target-current Node extensions after `v0.0.46`";
const BASELINE_ROUTE_COUNT = 201;
const TARGET_ROUTE_COUNT = 202;
const POST_BASELINE_ROUTES = new Set(["GET /api/internal/instance-shell"]);
const WEB_PROXY_METHODS = ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"];
const WEB_PROXY_ALIAS_PATH = "/api/apps/sessions/{}/web/";
const WEB_PROXY_PATH = "/api/apps/sessions/{}/web/*";
const RUST_SENTINEL_ROUTE = "ANY /api/*";

function normalizedPath(value) {
  return value
    .replace(/\{\*rest\}/g, "*")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/:[^/]+/g, "{}");
}

function sorted(values) {
  return [...values].sort();
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

function nodeRouteSurface() {
  const routes = new Map();
  const unresolved = [];
  const upgradeListeners = [];
  const sourceRoot = path.join(root, "packages", "controlled-instance", "src");

  for (const file of sourceFiles(sourceRoot)) {
    const source = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const methodVariables = collectMethodVariables(sourceFile);
    const relativeFile = path.relative(root, file);

    const recordUnresolved = (node, detail) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      unresolved.push(`${relativeFile}:${line} ${detail}`);
    };

    const visit = (node) => {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "app") {
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

function matrixRouteSurface(markdown) {
  const routes = [];
  let section;
  for (const line of markdown.split("\n")) {
    if (line === BASELINE_HEADING) {
      section = "baseline";
      continue;
    }
    if (line === TARGET_HEADING) {
      section = "target-current";
      continue;
    }
    if (line.startsWith("## ")) section = undefined;
    if (!section) continue;

    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5) continue;
    const method = cells[0].match(/^`([A-Z]+)`$/)?.[1];
    const routePath = cells[1].match(/^`([^`]+)`$/)?.[1];
    if (!method || !routePath) continue;
    routes.push({
      section,
      method,
      path: normalizedPath(routePath),
      transport: cells[3],
      websocket: cells[3] === "WebSocket" || cells[3] === "HTTP/WS proxy",
    });
  }
  return routes;
}

function routeBlocks(source) {
  const result = [];
  let cursor = 0;
  while ((cursor = source.indexOf(".route(", cursor)) >= 0) {
    let index = cursor + ".route(".length;
    const start = index;
    let depth = 1;
    let quote = false;
    let escape = false;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escape) escape = false;
        else if (character === "\\") escape = true;
        else if (character === '"') quote = false;
        continue;
      }
      if (character === '"') quote = true;
      else if ("([{".includes(character)) depth += 1;
      else if (")]}".includes(character)) {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    result.push(source.slice(start, index));
    cursor = index + 1;
  }
  return result;
}

function parseRustRoute(block, origin) {
  const pathMatch = block.match(/"([^"]+)"/);
  if (!pathMatch) return undefined;
  let index = pathMatch.index + pathMatch[0].length;
  let depth = 0;
  let quote = false;
  let escape = false;
  for (; index < block.length; index += 1) {
    const character = block[index];
    if (quote) {
      if (escape) escape = false;
      else if (character === "\\") escape = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') quote = true;
    else if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (character === "," && depth <= 0) {
      index += 1;
      break;
    }
  }

  const chain = block.slice(index);
  const methods = new Map();
  const methodPattern = /(?:^|\.)\s*(get|post|put|patch|delete|options|any)\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of chain.matchAll(methodPattern)) {
    methods.set(match[1].toUpperCase() === "ANY" ? "ANY" : match[1].toUpperCase(), match[2]);
  }
  return { path: pathMatch[1], methods, origin };
}

function rustFunctions(source) {
  const functions = new Map();
  const declarations = [...source.matchAll(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>\n]*>)?\s*\(/gm)];
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    const start = declaration.index;
    const end = declarations[index + 1]?.index ?? source.length;
    functions.set(declaration[1], source.slice(start, end));
  }
  return functions;
}

function functionSupportsWebSocket(name, functions, seen = new Set()) {
  if (seen.has(name)) return false;
  seen.add(name);
  const body = functions.get(name);
  if (!body) return false;
  if (body.includes("WebSocketUpgrade") || body.includes("on_upgrade(")) return true;
  if (body.includes("header::UPGRADE") && body.includes('"websocket"')) return true;
  for (const match of body.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/g)) {
    if (functions.has(match[1]) && functionSupportsWebSocket(match[1], functions, seen)) return true;
  }
  return false;
}

function rustRouteSurface() {
  const source = fs.readFileSync(serverPath, "utf8");
  const testModule = source.lastIndexOf("#[cfg(test)]");
  assert.notEqual(testModule, -1, "server.rs must keep tests behind #[cfg(test)]");
  const production = source.slice(0, testModule);
  const functions = rustFunctions(production);
  const routes = new Map();
  const unresolved = [];

  for (const block of routeBlocks(production)) {
    const route = parseRustRoute(block, block.slice(0, 80));
    if (!route) {
      unresolved.push("unparsed .route() registration");
      continue;
    }
    if (route.methods.size === 0) unresolved.push(`no methods for ${route.path}`);
    const paths = route.path.includes("{prefix}")
      ? [
        route.path.replace("{prefix}", "/api/ai-sessions/{id}/repository"),
        route.path.replace("{prefix}", "/api/apps/sessions/{id}/repository"),
      ]
      : [route.path];
    for (const routePath of paths) {
      for (const [method, handler] of route.methods) {
        const key = `${method} ${normalizedPath(routePath)}`;
        routes.set(key, {
          method,
          path: normalizedPath(routePath),
          websocket: method === "GET" && functionSupportsWebSocket(handler, functions),
          handler,
        });
      }
    }
  }

  return { routes, unresolved };
}

test("Node registrations define the baseline and target-current matrix", () => {
  const node = nodeRouteSurface();
  const matrix = matrixRouteSurface(fs.readFileSync(matrixPath, "utf8"));
  const baseline = matrix.filter((route) => route.section === "baseline");
  const targetCurrent = matrix.filter((route) => route.section === "target-current");
  const documented = new Set(matrix.map(({ method, path: routePath }) => `${method} ${routePath}`));
  const baselineKeys = new Set(baseline.map(({ method, path: routePath }) => `${method} ${routePath}`));
  const targetKeys = new Set(targetCurrent.map(({ method, path: routePath }) => `${method} ${routePath}`));
  const nodeKeys = new Set(node.routes.keys());
  const matrixWebSocket = new Set(
    matrix.filter((route) => route.websocket).map(({ method, path: routePath }) => `${method} ${routePath}`),
  );
  const nodeWebSocket = new Set(
    [...node.routes].filter(([, route]) => route.websocket).map(([key]) => key),
  );

  assert.deepEqual(node.unresolved, []);
  assert.deepEqual(node.upgradeListeners, []);
  assert.equal(baseline.length, BASELINE_ROUTE_COUNT);
  assert.equal(baselineKeys.size, BASELINE_ROUTE_COUNT);
  assert.equal(targetKeys.size, POST_BASELINE_ROUTES.size);
  assert.deepEqual(sorted(targetKeys), sorted(POST_BASELINE_ROUTES));
  assert.equal(nodeKeys.size, TARGET_ROUTE_COUNT);
  assert.deepEqual(sorted(documented), sorted(nodeKeys));
  assert.deepEqual(
    sorted([...baselineKeys].filter((route) => POST_BASELINE_ROUTES.has(route))),
    [],
  );
  assert.deepEqual(sorted([...nodeKeys].filter((route) => !baselineKeys.has(route) && !targetKeys.has(route))), []);
  assert.deepEqual(sorted(matrixWebSocket), sorted(nodeWebSocket));
});

test("Rust production router exactly matches the Node route contract", () => {
  const node = nodeRouteSurface();
  const rust = rustRouteSurface();
  const nodeKeys = new Set(node.routes.keys());
  const actual = new Map();
  const aliases = new Set();
  const sentinels = new Set();

  for (const [key, route] of rust.routes) {
    if (key === RUST_SENTINEL_ROUTE) {
      sentinels.add(key);
      continue;
    }
    if (route.path === WEB_PROXY_ALIAS_PATH) {
      aliases.add(key);
      const canonicalPath = WEB_PROXY_PATH;
      actual.set(`${route.method} ${canonicalPath}`, { ...route, path: canonicalPath });
      continue;
    }
    actual.set(key, route);
  }

  assert.deepEqual(rust.unresolved, []);
  assert.deepEqual([...sentinels], [RUST_SENTINEL_ROUTE]);
  assert.deepEqual(
    sorted(aliases),
    sorted(WEB_PROXY_METHODS.map((method) => `${method} ${WEB_PROXY_ALIAS_PATH}`)),
  );
  assert.deepEqual(sorted([...actual.keys()].filter((route) => !nodeKeys.has(route))), []);
  assert.deepEqual(sorted([...nodeKeys].filter((route) => !actual.has(route))), []);
  assert.deepEqual(
    sorted([...actual].filter(([, route]) => route.websocket).map(([key]) => key)),
    sorted([...node.routes].filter(([, route]) => route.websocket).map(([key]) => key)),
  );
  assert.equal(actual.size, TARGET_ROUTE_COUNT);
});
