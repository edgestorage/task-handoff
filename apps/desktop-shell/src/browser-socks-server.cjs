const net = require("node:net");

class BrowserSocksServer {
  constructor(channel, options = {}) {
    this.channel = channel;
    this.createServer = options.createServer || net.createServer;
    this.server = undefined;
    this.sockets = new Set();
  }

  async start() {
    if (this.server) return this.address();
    const server = this.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return this.address();
  }

  address() {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Browser SOCKS server is not listening.");
    return { host: "127.0.0.1", port: address.port };
  }

  accept(socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    let state = "greeting";
    let pending = Buffer.alloc(0);
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        if (state === "greeting") {
          if (pending.byteLength < 2) return;
          if (pending[0] !== 5) throw new Error("Unsupported SOCKS version.");
          const methods = pending.readUInt8(1);
          if (pending.byteLength < 2 + methods) return;
          const offered = pending.subarray(2, 2 + methods);
          pending = pending.subarray(2 + methods);
          socket.write(Buffer.from([5, offered.includes(0) ? 0 : 0xff]));
          if (!offered.includes(0)) return socket.end();
          state = "request";
        }
        if (state === "request") {
          const request = parseSocksRequest(pending);
          if (!request) return;
          pending = pending.subarray(request.bytes);
          if (request.command !== 1) {
            socket.write(socksReply(7));
            return socket.end();
          }
          state = "connecting";
          socket.pause();
          socket.removeListener("data", onData);
          void this.channel.attach({ host: request.host, port: request.port }, socket).then(() => {
            state = "stream";
            socket.write(socksReply(0));
            if (pending.byteLength) socket.emit("data", pending);
          }).catch(() => {
            socket.write(socksReply(5));
            socket.end();
          });
        }
      } catch {
        socket.write(socksReply(1));
        socket.end();
      }
    };
    socket.on("data", onData);
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
  }
}

function parseSocksRequest(input) {
  if (input.byteLength < 4) return undefined;
  if (input[0] !== 5 || input[2] !== 0) throw new Error("Invalid SOCKS request.");
  const command = input[1];
  const type = input[3];
  let host;
  let offset;
  if (type === 1) {
    if (input.byteLength < 10) return undefined;
    host = [...input.subarray(4, 8)].join(".");
    offset = 8;
  } else if (type === 3) {
    if (input.byteLength < 5) return undefined;
    const length = input[4];
    if (input.byteLength < 7 + length) return undefined;
    host = input.subarray(5, 5 + length).toString("utf8");
    offset = 5 + length;
  } else if (type === 4) {
    if (input.byteLength < 22) return undefined;
    host = Array.from({ length: 8 }, (_, index) => input.readUInt16BE(4 + index * 2).toString(16)).join(":");
    offset = 20;
  } else {
    throw new Error("Unsupported SOCKS address type.");
  }
  return { command, host, port: input.readUInt16BE(offset), bytes: offset + 2 };
}

function socksReply(code) {
  return Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
}

module.exports = { BrowserSocksServer, parseSocksRequest };
