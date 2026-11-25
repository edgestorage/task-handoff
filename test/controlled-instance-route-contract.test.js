const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { nodeRouteSurface, normalizedPath } = require("./fixtures/controlled-instance-route-surface.js");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "controlled-instance-rs", "crates", "instance", "src", "server.rs");
const remoteDesktopPath = path.join(root, "controlled-instance-rs", "crates", "instance", "src", "remote_desktop.rs");
const browserControlPath = path.join(root, "controlled-instance-rs", "crates", "instance", "src", "browser_control_routes.rs");
const browserCdpPath = path.join(root, "controlled-instance-rs", "crates", "instance", "src", "browser_cdp_bridge.rs");
const matrixPath = path.join(root, "controlled-instance-rs", "docs", "http-route-matrix.md");

const BASELINE_HEADING = "## `v0.0.47` compatibility baseline";
const TARGET_HEADING = "## Target-current Node extensions after `v0.0.47`";
const BASELINE_ROUTE_COUNT = 202;
const TARGET_ROUTE_COUNT = 246;
const POST_BASELINE_ROUTES = new Set([
  "DELETE /api/browser-control/access",
  "DELETE /api/browser-control/creation-context",
  "DELETE /api/browser-control/sources/{}",
  "GET /api/browser-control/access",
  "GET /api/browser-control/creation-context",
  "GET /api/browser-control/relay",
  "GET /api/apps/install-environment",
  "PUT /api/apps/install-environment",
  "POST /api/apps/install-environment/test",
  "POST /api/apps/install-environment/prepare",
  "GET /api/ai-sessions/{}/repository/files/content",
  "GET /api/apps/sessions/{}/repository/files/content",
  "GET /api/ai-sessions/{}/turns/{}/tool-activity",
  "POST /api/ai-sessions/{}/unread",
  "GET /devtools/browser/{}",
  "GET /devtools/page/{}",
  "GET /json/close/{}",
  "GET /json/list",
  "GET /json/list/",
  "GET /json/new",
  "GET /json/protocol",
  "GET /json/protocol/",
  "GET /json/version",
  "GET /json/version/",
  "POST /api/browser-control/access",
  "POST /api/browser-control/access-requests/{}/deny",
  "POST /api/browser-control/sources",
  "POST /api/browser-control/sources/{}/deltas",
  "PUT /api/browser-control/creation-context",
  "PUT /api/browser-control/sources/{}/snapshot",
  "PUT /json/new",
  "GET /api/internal/remote-desktop/attach",
  "GET /api/internal/remote-desktop/fallback/{}",
  "GET /api/internal/remote-desktop/permissions",
  "GET /api/internal/remote-desktop/settings",
  "POST /api/internal/remote-desktop/force-stop",
  "POST /api/internal/remote-desktop/permissions/request",
  "POST /api/internal/remote-desktop/preflight",
  "POST /api/internal/remote-desktop/reserve",
  "POST /api/internal/remote-desktop/snapshot",
  "POST /api/internal/remote-desktop/sources",
  "POST /api/internal/remote-desktop/stop",
  "POST /api/internal/remote-desktop/takeover",
  "PUT /api/internal/remote-desktop/settings",
]);
const WEB_PROXY_METHODS = ["DELETE", "GET", "OPTIONS", "PATCH", "POST", "PUT"];
const WEB_PROXY_ALIAS_PATH = "/api/apps/sessions/{}/web/";
const WEB_PROXY_PATH = "/api/apps/sessions/{}/web/*";
const RUST_SENTINEL_ROUTE = "ANY /api/*";
function sorted(values) {
  return [...values].sort();
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
  const server = fs.readFileSync(serverPath, "utf8");
  const testModule = server.lastIndexOf("#[cfg(test)]");
  assert.notEqual(testModule, -1, "server.rs must keep tests behind #[cfg(test)]");
  const serverProduction = server.slice(0, testModule);
  const desktop = serverProduction.includes(".merge(crate::remote_desktop::routes(")
    ? fs.readFileSync(remoteDesktopPath, "utf8").split("#[cfg(test)]")[0]
    : "";
  const browserControl = serverProduction.includes(".merge(crate::browser_control_routes::routes(")
    ? fs.readFileSync(browserControlPath, "utf8").split("#[cfg(test)]")[0]
    : "";
  const browserCdp = serverProduction.includes(".merge(crate::browser_cdp_bridge::routes(")
    ? fs.readFileSync(browserCdpPath, "utf8").split("#[cfg(test)]")[0]
    : "";
  const production = [serverProduction, desktop, browserControl, browserCdp].join("\n");
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

const releaseRouteSnapshot = JSON.parse(fs.readFileSync(
  path.join(root, "controlled-instance-rs/docs/fixtures/node-routes-v0.0.47.json"), "utf8",
));

function wireRoutes(routes) {
  return routes.map(({ method, path: routePath, websocket }) =>
    `${method} ${routePath} websocket=${websocket}`,
  ).sort();
}

test("matrix compatibility baseline matches pinned release registrations", () => {
  const baseline = matrixRouteSurface(fs.readFileSync(matrixPath, "utf8"))
    .filter((route) => route.section === "baseline");
  assert.deepEqual(wireRoutes(baseline), wireRoutes(releaseRouteSnapshot.routes));
});

test("migration inventory and route evidence use the same compatibility release", () => {
  const inventory = JSON.parse(fs.readFileSync(
    path.join(root, "controlled-instance-rs/docs/migration-inventory.json"), "utf8",
  ));
  assert.equal(inventory.compatibilityBaseline, releaseRouteSnapshot.source.ref);
  const versions = fs.readFileSync(
    path.join(root, "controlled-instance-rs/crates/protocol/src/versions.rs"), "utf8",
  );
  const rustBaseline = versions.match(/pub const COMPATIBILITY_BASELINE: &str = "([^"]+)";/)?.[1];
  assert.equal(rustBaseline, inventory.compatibilityBaseline);
});

test("Node registrations define the baseline and target-current matrix", () => {
  const node = nodeRouteSurface(root);
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
  const node = nodeRouteSurface(root);
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
