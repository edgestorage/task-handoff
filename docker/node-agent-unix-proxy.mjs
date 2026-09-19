import http from "node:http";

const socketPath = process.argv[2];
const port = Number(process.argv[3] || "19001");
if (!socketPath || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Usage: node-agent-unix-proxy.mjs <socket-path> [port]");
}

const server = http.createServer((request, response) => {
  const upstream = http.request({
    socketPath,
    method: request.method,
    path: request.url,
    headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NODE_AGENT_CONTAINER_IPC_UNAVAILABLE", message: error.message } }));
  });
  request.pipe(upstream);
});

server.listen(port, "127.0.0.1");
