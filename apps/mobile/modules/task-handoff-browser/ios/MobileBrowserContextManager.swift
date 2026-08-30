import Foundation
import CryptoKit
import Network
import OSLog
import WebKit

private let browserContextLogger = Logger(subsystem: "com.taskhandoff.mobile.dev", category: "task-handoff-browser")

internal actor MobileBrowserContextManager {
  static let shared = MobileBrowserContextManager()

  private struct Context {
    let id: String
    let key: String
    let dataStore: WKWebsiteDataStore
    let channel: BrowserTunnelChannel
    let socks: BrowserSocksServer
    var references: Int
  }

  private var contextsById: [String: Context] = [:]
  private var contextIdByKey: [String: String] = [:]
  private var preparedContexts = 0
  private var releasedContexts = 0

  @available(iOS 17.0, *)
  func prepare(_ input: PrepareBrowserContextRecord) async throws -> String {
    let key = "\(input.controlPlaneId)\u{0}\(input.instanceId)"
    if let id = contextIdByKey[key], var context = contextsById[id] {
      context.references += 1
      contextsById[id] = context
      browserDiagnostic("context reused id=\(id) references=\(context.references)")
      return id
    }

    // The token remains in this stack frame only. The tunnel consumes it while
    // establishing the relay and never includes it in the opaque context id.
    guard !input.token.isEmpty, let relayURL = URL(string: input.relayUrl), ["ws", "wss"].contains(relayURL.scheme?.lowercased()) else {
      throw BrowserContextUnavailableException()
    }
    let channel = BrowserTunnelChannel(url: relayURL, token: input.token)
    try await channel.connect()
    let socks = BrowserSocksServer(channel: channel)
    let address: BrowserSocksServer.Address
    do {
      address = try await socks.start()
    } catch {
      await channel.close()
      throw error
    }
    let dataStore = await MainActor.run {
      let store = WKWebsiteDataStore(forIdentifier: profileIdentifier(key))
      var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: address.host, port: address.port))
      proxy.allowFailover = false
      store.proxyConfigurations = [proxy]
      browserDiagnostic("iOS WebView SOCKS proxy configured host=\(address.host) port=\(address.port) profile=\(profileIdentifier(key))")
      return store
    }
    let id = UUID().uuidString.lowercased()
    let context = Context(id: id, key: key, dataStore: dataStore, channel: channel, socks: socks, references: 1)
    contextsById[id] = context
    contextIdByKey[key] = id
    preparedContexts += 1
    browserDiagnostic("context prepared id=\(id) instance=\(input.instanceId)")
    return id
  }

  func dataStore(contextId: String) -> WKWebsiteDataStore? {
    contextsById[contextId]?.dataStore
  }

  func activate(contextId: String) throws {
    guard contextsById[contextId] != nil else { throw BrowserContextUnavailableException() }
  }

  func release(contextId: String) async {
    guard var context = contextsById[contextId] else { return }
    context.references -= 1
    if context.references > 0 {
      contextsById[contextId] = context
      return
    }
    contextsById.removeValue(forKey: contextId)
    contextIdByKey.removeValue(forKey: context.key)
    releasedContexts += 1
    browserDiagnostic("context released id=\(contextId)")
    await context.socks.close()
    await context.channel.close()
  }

  func releaseAll() async {
    let active = Array(contextsById.values)
    contextsById.removeAll()
    contextIdByKey.removeAll()
    releasedContexts += active.count
    for context in active {
      await context.socks.close()
      await context.channel.close()
    }
  }

  func diagnostics() -> [String: Int] {
    ["activeContexts": contextsById.count, "preparedContexts": preparedContexts, "releasedContexts": releasedContexts]
  }
}

private func browserDiagnostic(_ message: String) {
  NSLog("[task-handoff-browser] %@", message)
  browserContextLogger.info("\(message, privacy: .public)")
}

private func profileIdentifier(_ key: String) -> UUID {
  let digest = Array(SHA256.hash(data: Data(key.utf8)).prefix(16))
  let value = digest.map { String(format: "%02x", $0) }.joined()
  return UUID(uuidString: "\(value.prefix(8))-\(value.dropFirst(8).prefix(4))-\(value.dropFirst(12).prefix(4))-\(value.dropFirst(16).prefix(4))-\(value.dropFirst(20).prefix(12))")!
}
