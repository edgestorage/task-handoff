import fs from "node:fs";
import net from "node:net";

export function removeStaleSocket(socketPath: string) {
  return new Promise<void>((resolve, reject) => {
    if (!fs.existsSync(socketPath)) {
      resolve();
      return;
    }

    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.end();
      reject(new Error(`Receiver already running at ${socketPath}`));
    });
    probe.once("error", () => {
      fs.unlinkSync(socketPath);
      resolve();
    });
  });
}

export function unlinkSocket(socketPath: string) {
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }
}
