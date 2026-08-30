import Foundation
import OSLog

private let browserTunnelLogger = Logger(subsystem: "com.taskhandoff.mobile.dev", category: "task-handoff-browser")

internal actor BrowserTunnelChannel {
  typealias DataSink = @Sendable (Data) async throws -> Void
  typealias SignalSink = @Sendable () async -> Void

  private final class Stream: @unchecked Sendable {
    let id: UInt32
    let onData: DataSink
    let onHalfClose: SignalSink
    let onClose: SignalSink
    var state = "opening"
    var sendCredit: Int
    var receiveCredit = BrowserTunnelProtocol.initialWindow
    var openContinuation: CheckedContinuation<Void, Error>?
    var creditContinuations: [CheckedContinuation<Void, Error>] = []

    init(id: UInt32, sendCredit: Int, onData: @escaping DataSink, onHalfClose: @escaping SignalSink, onClose: @escaping SignalSink) {
      self.id = id
      self.sendCredit = sendCredit
      self.onData = onData
      self.onHalfClose = onHalfClose
      self.onClose = onClose
    }
  }

  private let task: URLSessionWebSocketTask
  private var streams: [UInt32: Stream] = [:]
  private var nextStreamId: UInt32 = 1
  private var initialWindow = BrowserTunnelProtocol.initialWindow
  private var state = "connecting"
  private var receiveTask: Task<Void, Never>?

  init(url: URL, token: String) {
    var request = URLRequest(url: url)
    request.setValue("Browser \(token)", forHTTPHeaderField: "Authorization")
    task = URLSession(configuration: .ephemeral).webSocketTask(with: request)
  }

  func connect() async throws {
    guard state == "connecting" else { return }
    task.resume()
    try await task.send(.string(BrowserTunnelProtocol.hello()))
    let message = try await withThrowingTaskGroup(of: URLSessionWebSocketTask.Message.self) { group in
      group.addTask { try await self.task.receive() }
      group.addTask {
        try await Task.sleep(for: .seconds(15))
        throw BrowserTunnelProtocolError("Browser relay handshake timed out.")
      }
      let first = try await group.next()!
      group.cancelAll()
      return first
    }
    let readyData: Data
    switch message {
    case .string(let value): readyData = Data(value.utf8)
    case .data(let value): readyData = value
    @unknown default: throw BrowserTunnelProtocolError("Browser relay ready message is invalid.")
    }
    let ready = try JSONDecoder().decode(BrowserTunnelProtocol.Ready.self, from: readyData)
    guard ready.type == "browser-tunnel.ready", ready.protocolVersion == BrowserTunnelProtocol.version,
          ready.initialWindowBytes > 0, ready.initialWindowBytes <= BrowserTunnelProtocol.maxWindow else {
      throw BrowserTunnelProtocolError("Browser relay protocol is incompatible.")
    }
    initialWindow = ready.initialWindowBytes
    state = "ready"
    receiveTask = Task { await self.receiveLoop() }
  }

  func open(host: String, port: UInt16, onData: @escaping DataSink, onHalfClose: @escaping SignalSink, onClose: @escaping SignalSink) async throws -> UInt32 {
    guard state == "ready", streams.count < 256 else { throw BrowserTunnelProtocolError("Browser relay stream limit reached.") }
    let id = allocateStreamId()
    let stream = Stream(id: id, sendCredit: initialWindow, onData: onData, onHalfClose: onHalfClose, onClose: onClose)
    streams[id] = stream
    browserDiagnostic("tunnel OPEN stream=\(id) target=\(host):\(port)")
    // Install the waiter before sending OPEN. A fast relay can answer OPEN_OK
    // before send() returns; registering it afterwards loses the response.
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      stream.openContinuation = continuation
      Task { [weak self] in
        guard let self else { return }
        do {
          try await self.send(BrowserTunnelProtocol.open(streamId: id, host: host, port: port))
        } catch {
          await self.failOpen(streamId: id, error: error)
        }
      }
    }
    return id
  }

  private func failOpen(streamId: UInt32, error: Error) {
    guard let stream = streams.removeValue(forKey: streamId) else { return }
    stream.state = "closed"
    stream.openContinuation?.resume(throwing: error)
    stream.openContinuation = nil
  }

  func sendData(streamId: UInt32, data: Data) async throws {
    var offset = 0
    while offset < data.count {
      guard let stream = streams[streamId], stream.state == "open" else { throw BrowserTunnelProtocolError("Browser tunnel stream is closed.") }
      if stream.sendCredit == 0 {
        try await withCheckedThrowingContinuation { stream.creditContinuations.append($0) }
        continue
      }
      let count = min(data.count - offset, stream.sendCredit, BrowserTunnelProtocol.maxDataBytes)
      let payload = data.subdata(in: offset..<(offset + count))
      stream.sendCredit -= count
      try await send(BrowserTunnelProtocol.encode(.init(type: .data, streamId: streamId, payload: payload)))
      offset += count
    }
  }

  func halfClose(streamId: UInt32) async {
    guard streams[streamId]?.state == "open" else { return }
    try? await send(BrowserTunnelProtocol.encode(.init(type: .halfClose, streamId: streamId, payload: Data())))
  }

  func closeStream(streamId: UInt32, notify: Bool = true) async {
    guard let stream = streams.removeValue(forKey: streamId) else { return }
    stream.state = "closed"
    stream.openContinuation?.resume(throwing: BrowserTunnelProtocolError("Target connection closed before opening."))
    stream.openContinuation = nil
    for continuation in stream.creditContinuations { continuation.resume(throwing: BrowserTunnelProtocolError("Browser tunnel stream closed.")) }
    stream.creditContinuations.removeAll()
    if notify, state == "ready" { try? await send(BrowserTunnelProtocol.encode(.init(type: .close, streamId: streamId, payload: Data()))) }
  }

  func close() async {
    guard state != "closed" else { return }
    state = "closed"
    receiveTask?.cancel()
    receiveTask = nil
    let active = Array(streams.values)
    streams.removeAll()
    for stream in active {
      stream.openContinuation?.resume(throwing: BrowserTunnelProtocolError("Browser relay closed."))
      for continuation in stream.creditContinuations { continuation.resume(throwing: BrowserTunnelProtocolError("Browser relay closed.")) }
      await stream.onClose()
    }
    task.cancel(with: .goingAway, reason: nil)
  }

  private func receiveLoop() async {
    do {
      while state == "ready" {
        let message = try await task.receive()
        guard case .data(let data) = message else { throw BrowserTunnelProtocolError("Browser relay frames must be binary.") }
        try await handle(BrowserTunnelProtocol.decode(data))
      }
    } catch {
      await close()
    }
  }

  private func handle(_ frame: BrowserTunnelProtocol.Frame) async throws {
    guard let stream = streams[frame.streamId] else { return }
    switch frame.type {
    case .openOk:
      guard stream.state == "opening" else { throw BrowserTunnelProtocolError("Unexpected OPEN_OK frame.") }
      stream.state = "open"
      stream.openContinuation?.resume()
      stream.openContinuation = nil
    case .data:
      guard stream.state == "open", frame.payload.count <= stream.receiveCredit else { throw BrowserTunnelProtocolError("Browser tunnel receive window exceeded.") }
      stream.receiveCredit -= frame.payload.count
      try await stream.onData(frame.payload)
      stream.receiveCredit += frame.payload.count
      try await send(BrowserTunnelProtocol.windowUpdate(streamId: frame.streamId, bytes: frame.payload.count))
    case .windowUpdate:
      let bytes = try BrowserTunnelProtocol.windowBytes(frame)
      guard stream.sendCredit + bytes <= BrowserTunnelProtocol.maxWindow else { throw BrowserTunnelProtocolError("Browser tunnel send window exceeded.") }
      stream.sendCredit += bytes
      let waiters = stream.creditContinuations
      stream.creditContinuations.removeAll()
      for waiter in waiters { waiter.resume() }
    case .halfClose:
      await stream.onHalfClose()
    case .close:
      await closeStream(streamId: frame.streamId, notify: false)
      await stream.onClose()
    case .error:
      let remote = try? JSONDecoder().decode(BrowserTunnelProtocol.TunnelError.self, from: frame.payload)
      await closeStream(streamId: frame.streamId, notify: false)
      stream.openContinuation?.resume(throwing: BrowserTunnelProtocolError(remote?.message ?? "Target connection failed."))
      await stream.onClose()
    case .open:
      throw BrowserTunnelProtocolError("Browser client cannot receive OPEN frames.")
    }
  }

  private func send(_ data: Data) async throws {
    guard state != "closed" else { throw BrowserTunnelProtocolError("Browser relay is closed.") }
    try await task.send(.data(data))
  }

  private func allocateStreamId() -> UInt32 {
    while streams[nextStreamId] != nil { nextStreamId = nextStreamId == UInt32.max ? 1 : nextStreamId + 1 }
    let value = nextStreamId
    nextStreamId = nextStreamId == UInt32.max ? 1 : nextStreamId + 1
    return value
  }
}

private func browserDiagnostic(_ message: String) {
  NSLog("[task-handoff-browser] %@", message)
  browserTunnelLogger.info("\(message, privacy: .public)")
}
