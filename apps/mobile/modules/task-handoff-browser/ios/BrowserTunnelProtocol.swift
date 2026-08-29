import Foundation

internal enum BrowserTunnelProtocol {
  static let version = "2026-08-29"
  static let headerBytes = 9
  static let initialWindow = 256 * 1024
  static let maxDataBytes = 64 * 1024
  static let maxControlBytes = 4 * 1024
  static let maxWindow = 16 * 1024 * 1024

  enum FrameType: UInt8 {
    case open = 1
    case openOk = 2
    case data = 3
    case halfClose = 4
    case close = 5
    case error = 6
    case windowUpdate = 7
  }

  struct Frame {
    let type: FrameType
    let streamId: UInt32
    let payload: Data
  }

  struct Ready: Decodable {
    let type: String
    let protocolVersion: String
    let initialWindowBytes: Int
  }

  struct TunnelError: Decodable {
    let code: String
    let message: String
  }

  static func hello() throws -> String {
    let value: [String: Any] = [
      "type": "browser-tunnel.hello",
      "protocolVersion": version,
      "initialWindowBytes": initialWindow,
    ]
    return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
  }

  static func open(streamId: UInt32, host: String, port: UInt16) throws -> Data {
    guard !host.isEmpty, host.utf8.count <= 255,
          host.rangeOfCharacter(from: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "/?#@\\[]"))) == nil else {
      throw BrowserTunnelProtocolError("Browser tunnel target is invalid.")
    }
    return try encode(Frame(
      type: .open,
      streamId: streamId,
      payload: JSONSerialization.data(withJSONObject: ["host": host, "port": Int(port)])
    ))
  }

  static func windowUpdate(streamId: UInt32, bytes: Int) throws -> Data {
    guard bytes > 0, bytes <= maxWindow else { throw BrowserTunnelProtocolError("Browser tunnel window update is invalid.") }
    var value = UInt32(bytes).bigEndian
    return try encode(Frame(type: .windowUpdate, streamId: streamId, payload: Data(bytes: &value, count: 4)))
  }

  static func encode(_ frame: Frame) throws -> Data {
    guard frame.streamId > 0 else { throw BrowserTunnelProtocolError("Browser tunnel stream id must be positive.") }
    let maxPayload = frame.type == .data ? maxDataBytes : maxControlBytes
    guard frame.payload.count <= maxPayload else { throw BrowserTunnelProtocolError("Browser tunnel frame is too large.") }
    if [.openOk, .halfClose, .close].contains(frame.type), !frame.payload.isEmpty {
      throw BrowserTunnelProtocolError("Browser tunnel control payload must be empty.")
    }
    var output = Data(capacity: headerBytes + frame.payload.count)
    output.append(frame.type.rawValue)
    var streamId = frame.streamId.bigEndian
    var length = UInt32(frame.payload.count).bigEndian
    output.append(Data(bytes: &streamId, count: 4))
    output.append(Data(bytes: &length, count: 4))
    output.append(frame.payload)
    return output
  }

  static func decode(_ input: Data) throws -> Frame {
    guard input.count >= headerBytes,
          let type = FrameType(rawValue: input[input.startIndex]),
          let streamId = uint32(input, offset: 1),
          let length = uint32(input, offset: 5),
          streamId > 0,
          Int(length) == input.count - headerBytes else {
      throw BrowserTunnelProtocolError("Browser tunnel frame is invalid.")
    }
    let payload = input.subdata(in: headerBytes..<input.count)
    let frame = Frame(type: type, streamId: streamId, payload: payload)
    _ = try encode(frame)
    return frame
  }

  static func windowBytes(_ frame: Frame) throws -> Int {
    guard frame.type == .windowUpdate, frame.payload.count == 4,
          let bytes = uint32(frame.payload, offset: 0), bytes > 0, bytes <= maxWindow else {
      throw BrowserTunnelProtocolError("Browser tunnel window update is invalid.")
    }
    return Int(bytes)
  }

  private static func uint32(_ data: Data, offset: Int) -> UInt32? {
    guard offset >= 0, offset + 4 <= data.count else { return nil }
    return data[offset..<(offset + 4)].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
  }
}

internal struct BrowserTunnelProtocolError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}
