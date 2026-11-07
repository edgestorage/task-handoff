import Foundation

internal protocol BrowserMessageTransport: Sendable {
  func connect() async throws
  func send(_ message: URLSessionWebSocketTask.Message) async throws
  func receive() async throws -> URLSessionWebSocketTask.Message
  func consumed() async
  func close() async
}

internal final class BrowserWebSocketTransport: BrowserMessageTransport, @unchecked Sendable {
  private let session: URLSession
  private let task: URLSessionWebSocketTask
  init(url: URL, token: String) {
    var request = URLRequest(url: url)
    request.setValue("Browser \(token)", forHTTPHeaderField: "Authorization")
    session = URLSession(configuration: .ephemeral)
    task = session.webSocketTask(with: request)
    task.maximumMessageSize = 64 * 1024 + 9
  }
  func connect() async throws { task.resume() }
  func send(_ message: URLSessionWebSocketTask.Message) async throws { try await task.send(message) }
  func receive() async throws -> URLSessionWebSocketTask.Message { try await task.receive() }
  func consumed() async {}
  func close() async { task.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
}

/** Native byte bridge. Each direction is acknowledged after its consumer accepts it. */
internal actor BridgedBrowserTransport: BrowserMessageTransport {
  let id: String
  private let emit: @Sendable (String, [String: Any]) -> Void
  private var closed = false
  private var nextSequence = 0
  private var sends: [Int: (Int, CheckedContinuation<Void, Error>)] = [:]
  private var queuedBytes = 0
  private var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
  private var incoming: URLSessionWebSocketTask.Message?
  private var consumption: CheckedContinuation<Void, Error>?

  init(id: String, emit: @escaping @Sendable (String, [String: Any]) -> Void) { self.id = id; self.emit = emit }
  func connect() async throws { if closed { throw BrowserContextUnavailableException() } }
  func send(_ message: URLSessionWebSocketTask.Message) async throws {
    let data: Data
    let binary: Bool
    switch message {
    case .data(let value): data = value; binary = true
    case .string(let value): data = Data(value.utf8); binary = false
    @unknown default: throw BrowserContextUnavailableException()
    }
    guard !closed, !data.isEmpty, data.count <= 64 * 1024 + 9, queuedBytes + data.count <= 2 * 1024 * 1024 else { throw BrowserContextUnavailableException() }
    nextSequence += 1
    let sequence = nextSequence
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      queuedBytes += data.count
      sends[sequence] = (data.count, continuation)
      emit("onBrowserTransportMessage", ["id": id, "sequence": sequence, "binary": binary, "data": data])
    }
  }
  func acknowledge(_ sequence: Int, error: String?) {
    guard let (bytes, continuation) = sends.removeValue(forKey: sequence) else { return }
    queuedBytes -= bytes
    if let error { continuation.resume(throwing: BrowserTunnelProtocolError(error)) }
    else { continuation.resume() }
  }
  func deliver(_ data: Data, binary: Bool) async throws {
    guard !closed, consumption == nil, !data.isEmpty, data.count <= 64 * 1024 + 9 else { throw BrowserContextUnavailableException() }
    let message: URLSessionWebSocketTask.Message
    if binary { message = .data(data) }
    else {
      guard let value = String(data: data, encoding: .utf8) else { throw BrowserContextUnavailableException() }
      message = .string(value)
    }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      consumption = continuation
      if let waiter = receiver { receiver = nil; waiter.resume(returning: message) }
      else { incoming = message }
    }
  }
  func receive() async throws -> URLSessionWebSocketTask.Message {
    if closed { throw BrowserContextUnavailableException() }
    if let message = incoming { incoming = nil; return message }
    return try await withCheckedThrowingContinuation { receiver = $0 }
  }
  func consumed() async { consumption?.resume(); consumption = nil }
  func close() async {
    guard !closed else { return }
    closed = true
    let error = BrowserContextUnavailableException()
    receiver?.resume(throwing: error); receiver = nil
    consumption?.resume(throwing: error); consumption = nil
    incoming = nil
    for (_, continuation) in sends.values { continuation.resume(throwing: error) }
    sends.removeAll(); queuedBytes = 0
    emit("onBrowserTransportClose", ["id": id])
  }
}

internal actor BrowserTransportRegistry {
  static let shared = BrowserTransportRegistry()
  private var transports: [String: BridgedBrowserTransport] = [:]
  func create(emit: @escaping @Sendable (String, [String: Any]) -> Void) -> String {
    let id = UUID().uuidString.lowercased()
    transports[id] = BridgedBrowserTransport(id: id, emit: emit)
    return id
  }
  func require(_ id: String) throws -> BridgedBrowserTransport {
    guard let transport = transports[id] else { throw BrowserContextUnavailableException() }
    return transport
  }
  func close(_ id: String) async { await transports.removeValue(forKey: id)?.close() }
  func closeAll() async {
    let active = Array(transports.values); transports.removeAll()
    for transport in active { await transport.close() }
  }
}
