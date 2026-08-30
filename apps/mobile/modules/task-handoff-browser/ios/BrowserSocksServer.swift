import Foundation
import Network
import OSLog

private let browserLogger = Logger(subsystem: "com.taskhandoff.mobile.dev", category: "task-handoff-browser")

internal final class BrowserSocksServer: @unchecked Sendable {
  struct Address: Sendable { let host: NWEndpoint.Host; let port: NWEndpoint.Port }

  private let channel: BrowserTunnelChannel
  private let queue = DispatchQueue(label: "dev.taskhandoff.browser.socks")
  private var listener: NWListener?
  private let lock = NSLock()
  private var connections: [ObjectIdentifier: NWConnection] = [:]

  init(channel: BrowserTunnelChannel) {
    self.channel = channel
  }

  func start() async throws -> Address {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    parameters.acceptLocalOnly = true
    let listener = try NWListener(using: parameters, on: .any)
    listener.newConnectionLimit = 256
    self.listener = listener
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    return try await withCheckedThrowingContinuation { continuation in
      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          guard let port = listener.port else {
            continuation.resume(throwing: BrowserTunnelProtocolError("SOCKS listener has no port."))
            return
          }
          listener.stateUpdateHandler = nil
          continuation.resume(returning: Address(host: .ipv4(.loopback), port: port))
        case .failed(let error):
          listener.stateUpdateHandler = nil
          continuation.resume(throwing: error)
        default: break
        }
      }
      listener.start(queue: queue)
    }
  }

  func close() async {
    listener?.cancel()
    listener = nil
    let active = lock.withLock {
      let active = Array(connections.values)
      connections.removeAll()
      return active
    }
    for connection in active { connection.cancel() }
  }

  private func accept(_ connection: NWConnection) {
    let id = ObjectIdentifier(connection)
    let allowed = lock.withLock {
      let allowed = connections.count < 256
      if allowed { connections[id] = connection }
      return allowed
    }
    guard allowed else { connection.cancel(); return }
    connection.stateUpdateHandler = { [weak self] state in
      if case .cancelled = state { self?.remove(id) }
      if case .failed = state { self?.remove(id) }
    }
    connection.start(queue: queue)
    Task { [weak self] in
      defer { connection.cancel(); self?.remove(id) }
      try? await self?.serve(connection)
    }
  }

  private func remove(_ id: ObjectIdentifier) {
    _ = lock.withLock { connections.removeValue(forKey: id) }
  }

  private func serve(_ connection: NWConnection) async throws {
    let reader = SocksReader(connection: connection)
    let greeting = try await reader.readExactly(2)
    guard greeting[0] == 5 else { throw BrowserTunnelProtocolError("Unsupported SOCKS version.") }
    let methods = try await reader.readExactly(Int(greeting[1]))
    let supportsNoAuth = methods.contains(0)
    browserLogger.info("SOCKS greeting methods=\(methods.map(String.init).joined(separator: ","), privacy: .public)")
    guard supportsNoAuth else {
      try await connection.write(Data([5, 0xff]))
      throw BrowserTunnelProtocolError("SOCKS authentication method is unsupported.")
    }
    try await connection.write(Data([5, 0]))
    browserLogger.info("SOCKS selected no-auth")

    let request = try await readRequest(reader)
    browserDiagnostic("SOCKS CONNECT target=\(request.host):\(request.port)")
    guard request.command == 1 else {
      try await connection.write(socksReply(7))
      throw BrowserTunnelProtocolError("Only SOCKS CONNECT is supported.")
    }

    let streamId: UInt32
    do {
      streamId = try await channel.open(
        host: request.host,
        port: request.port,
        onData: { data in try await connection.write(data) },
        onHalfClose: { await connection.finishWriting() },
        onClose: { connection.cancel() }
      )
    } catch {
      try? await connection.write(socksReply(5))
      throw error
    }
    try await connection.write(socksReply(0))

    do {
      while let data = try await connection.read(maximum: BrowserTunnelProtocol.maxDataBytes) {
        try await channel.sendData(streamId: streamId, data: data)
      }
      await channel.halfClose(streamId: streamId)
    } catch {
      await channel.closeStream(streamId: streamId)
      throw error
    }
  }

  private func readRequest(_ reader: SocksReader) async throws -> (command: UInt8, host: String, port: UInt16) {
    let header = try await reader.readExactly(4)
    guard header[0] == 5, header[2] == 0 else { throw BrowserTunnelProtocolError("SOCKS request is invalid.") }
    let host: String
    switch header[3] {
    case 1:
      host = (try await reader.readExactly(4)).map(String.init).joined(separator: ".")
    case 3:
      let length = try await reader.readExactly(1)[0]
      let data = try await reader.readExactly(Int(length))
      guard let value = String(data: data, encoding: .utf8), !value.isEmpty else { throw BrowserTunnelProtocolError("SOCKS hostname is invalid.") }
      host = value
    case 4:
      let data = try await reader.readExactly(16)
      host = stride(from: 0, to: 16, by: 2).map { String(format: "%x", UInt16(data[$0]) << 8 | UInt16(data[$0 + 1])) }.joined(separator: ":")
    default:
      throw BrowserTunnelProtocolError("SOCKS address type is unsupported.")
    }
    let portData = try await reader.readExactly(2)
    let port = UInt16(portData[0]) << 8 | UInt16(portData[1])
    guard port > 0 else { throw BrowserTunnelProtocolError("SOCKS target port is invalid.") }
    return (header[1], host, port)
  }

  private func socksReply(_ code: UInt8) -> Data { Data([5, code, 0, 1, 0, 0, 0, 0, 0, 0]) }
}

private final class SocksReader: @unchecked Sendable {
  private let connection: NWConnection
  private var buffer = Data()

  init(connection: NWConnection) { self.connection = connection }

  func readExactly(_ count: Int) async throws -> Data {
    guard count >= 0, count <= BrowserTunnelProtocol.maxControlBytes else { throw BrowserTunnelProtocolError("SOCKS message is too large.") }
    while buffer.count < count {
      guard let next = try await connection.read(maximum: BrowserTunnelProtocol.maxControlBytes), !next.isEmpty else {
        throw BrowserTunnelProtocolError("SOCKS connection ended unexpectedly.")
      }
      buffer.append(next)
    }
    let result = buffer.prefix(count)
    buffer.removeFirst(count)
    return Data(result)
  }
}

private func browserDiagnostic(_ message: String) {
  NSLog("[task-handoff-browser] %@", message)
  browserLogger.info("\(message, privacy: .public)")
}

private extension NWConnection {
  func readExactly(_ count: Int) async throws -> Data {
    guard count >= 0, count <= BrowserTunnelProtocol.maxControlBytes else { throw BrowserTunnelProtocolError("SOCKS message is too large.") }
    var result = Data()
    while result.count < count {
      guard let next = try await read(maximum: count - result.count), !next.isEmpty else {
        throw BrowserTunnelProtocolError("SOCKS connection ended unexpectedly.")
      }
      result.append(next)
    }
    return result
  }

  func read(maximum: Int) async throws -> Data? {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data?, Error>) in
      receive(minimumIncompleteLength: 1, maximumLength: maximum) { data, _, complete, error in
        if let error { continuation.resume(throwing: error) }
        else if let data, !data.isEmpty { continuation.resume(returning: data) }
        else if complete { continuation.resume(returning: nil) }
        else {
          Task {
            do { continuation.resume(returning: try await self.read(maximum: maximum)) }
            catch { continuation.resume(throwing: error) }
          }
        }
      }
    }
  }

  func write(_ data: Data) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      send(content: data, completion: .contentProcessed { error in
        if let error { continuation.resume(throwing: error) }
        else { continuation.resume() }
      })
    }
  }

  func finishWriting() async {
    await withCheckedContinuation { continuation in
      send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in continuation.resume() })
    }
  }
}
