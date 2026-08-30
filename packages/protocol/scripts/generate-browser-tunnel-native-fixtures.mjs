import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  BROWSER_TUNNEL_FRAME_HEADER_BYTES,
  BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_TUNNEL_MAX_CONTROL_BYTES,
  BROWSER_TUNNEL_MAX_DATA_BYTES,
  BROWSER_TUNNEL_MAX_WINDOW_BYTES,
  BROWSER_TUNNEL_PROTOCOL_VERSION,
  BrowserTunnelFrameType,
  encodeBrowserTunnelFrame,
  encodeBrowserTunnelHello,
  encodeBrowserTunnelOpen,
  encodeBrowserTunnelReady,
  encodeBrowserTunnelWindowUpdate,
} from "../src/browser-tunnel.ts";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/mobile/modules/task-handoff-browser/shared/browser-tunnel-fixtures.json",
);

const hex = (value) => value.toString("hex");
const fixture = `${JSON.stringify({
  protocolVersion: BROWSER_TUNNEL_PROTOCOL_VERSION,
  limits: {
    frameHeaderBytes: BROWSER_TUNNEL_FRAME_HEADER_BYTES,
    initialWindowBytes: BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
    maxDataBytes: BROWSER_TUNNEL_MAX_DATA_BYTES,
    maxControlBytes: BROWSER_TUNNEL_MAX_CONTROL_BYTES,
    maxWindowBytes: BROWSER_TUNNEL_MAX_WINDOW_BYTES,
  },
  frameTypes: BrowserTunnelFrameType,
  hello: encodeBrowserTunnelHello(),
  ready: encodeBrowserTunnelReady(),
  vectors: {
    openLocalhost3000: hex(encodeBrowserTunnelOpen(1, { host: "127.0.0.1", port: 3000 })),
    dataStream7: hex(encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.Data, streamId: 7, payload: Buffer.from([0, 1, 255]) })),
    windowUpdate4096: hex(encodeBrowserTunnelWindowUpdate(9, 4096)),
    halfCloseStream9: hex(encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.HalfClose, streamId: 9, payload: Buffer.alloc(0) })),
  },
}, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (!fs.existsSync(fixturePath) || fs.readFileSync(fixturePath, "utf8") !== fixture) {
    console.error(`Browser Tunnel native fixture is stale: ${fixturePath}`);
    process.exitCode = 1;
  }
} else {
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, fixture);
}
