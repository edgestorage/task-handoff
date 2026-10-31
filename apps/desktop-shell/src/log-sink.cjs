const unavailableStreams = new WeakSet();

function markLogStreamUnavailable(stream) {
  if (stream && (typeof stream === "object" || typeof stream === "function")) {
    unavailableStreams.add(stream);
  }
}

function writeLogLine(stream, message) {
  if (!stream || unavailableStreams.has(stream) || stream.destroyed || !stream.writable) {
    return;
  }
  try {
    stream.write(`${message}\n`, (error) => {
      if (error) markLogStreamUnavailable(stream);
    });
  } catch {
    markLogStreamUnavailable(stream);
  }
}

module.exports = { markLogStreamUnavailable, writeLogLine };
