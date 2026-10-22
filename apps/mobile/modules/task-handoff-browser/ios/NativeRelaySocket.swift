import Foundation
import OSLog

private let nativeRelaySocketLogger = Logger(subsystem: "com.taskhandoff.mobile.dev", category: "task-handoff-relay")

internal final class NativeRelaySocket: NSObject, URLSessionWebSocketDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  let id: String

  private let url: URL
  private let emit: (String, [String: Any?]) -> Void
  private let onFinish: (String) -> Void
  private let lock = NSLock()
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var started = false
  private var opened = false
  private var finished = false

  init(id: String, url: URL, emit: @escaping (String, [String: Any?]) -> Void, onFinish: @escaping (String) -> Void) {
    self.id = id
    self.url = url
    self.emit = emit
    self.onFinish = onFinish
    super.init()
  }

  func start() {
    lock.lock()
    guard !started && !finished else {
      lock.unlock()
      return
    }
    started = true
    lock.unlock()

    let configuration = URLSessionConfiguration.ephemeral
    configuration.waitsForConnectivity = false
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    let task = session.webSocketTask(with: url)
    task.maximumMessageSize = 16 * 1024 * 1024
    lock.lock()
    self.session = session
    self.task = task
    lock.unlock()
    task.resume()
  }

  func sendText(_ value: String) {
    send(.string(value))
  }

  func sendBinary(_ data: Data) {
    send(.data(data))
  }

  func close(code: Int, reason: String) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    let task = self.task
    let session = self.session
    lock.unlock()

    let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
    task?.cancel(with: closeCode, reason: Data(reason.utf8))
    session?.invalidateAndCancel()
    emitClose(code: code, reason: reason, clean: true)
    onFinish(id)
  }

  private func send(_ message: URLSessionWebSocketTask.Message) {
    lock.lock()
    let task = self.task
    let canSend = opened && !finished
    lock.unlock()
    guard canSend, let task else {
      handleFailure(NSError(domain: "TaskHandoffRelaySocket", code: 1, userInfo: [NSLocalizedDescriptionKey: "Relay WebSocket is not open."]))
      return
    }
    task.send(message) { [weak self] error in
      if let error { self?.handleFailure(error) }
    }
  }

  private func receiveNext() {
    lock.lock()
    let task = self.task
    let shouldReceive = opened && !finished
    lock.unlock()
    guard shouldReceive, let task else { return }
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let message):
        self.handle(message)
        self.receiveNext()
      case .failure(let error):
        self.handleFailure(error)
      }
    }
  }

  private func handle(_ message: URLSessionWebSocketTask.Message) {
    lock.lock()
    let canDeliver = opened && !finished
    lock.unlock()
    guard canDeliver else { return }
    switch message {
    case .string(let value):
      emit("onRelaySocketMessage", ["id": id, "type": "text", "data": value])
    case .data(let data):
      // Expo Modules converts NSData to a JS Uint8Array without the base64
      // expansion the bridge previously paid in both directions.
      emit("onRelaySocketMessage", ["id": id, "type": "binary", "data": data])
    @unknown default:
      handleFailure(NSError(domain: "TaskHandoffRelaySocket", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unsupported Relay WebSocket message type."]))
    }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol `protocol`: String?) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    opened = true
    lock.unlock()
    emit("onRelaySocketOpen", ["id": id, "protocol": `protocol` ?? ""])
    receiveNext()
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    let reasonText = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    finishWithClose(code: closeCode.rawValue, reason: reasonText, clean: closeCode != .abnormalClosure)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let error {
      handleFailure(error)
    } else {
      finishWithClose(code: 1000, reason: "", clean: true)
    }
  }

  private func handleFailure(_ error: Error) {
    let nsError = error as NSError
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    let session = self.session
    let task = self.task
    lock.unlock()

    task?.cancel(with: .abnormalClosure, reason: nil)
    session?.invalidateAndCancel()
    nativeRelaySocketLogger.error("relay socket failed id=\(self.id, privacy: .public) domain=\(nsError.domain, privacy: .public) code=\(nsError.code) message=\(nsError.localizedDescription, privacy: .public)")
    emit("onRelaySocketError", ["id": id, "domain": nsError.domain, "code": nsError.code, "message": nsError.localizedDescription])
    emit("onRelaySocketClose", ["id": id, "code": 1006, "reason": nsError.localizedDescription, "clean": false])
    onFinish(id)
  }

  private func finishWithClose(code: Int, reason: String, clean: Bool) {
    lock.lock()
    guard !finished else {
      lock.unlock()
      return
    }
    finished = true
    let session = self.session
    lock.unlock()
    session?.invalidateAndCancel()
    emitClose(code: code, reason: reason, clean: clean)
    onFinish(id)
  }

  private func emitClose(code: Int, reason: String, clean: Bool) {
    emit("onRelaySocketClose", ["id": id, "code": code, "reason": reason, "clean": clean])
  }
}
