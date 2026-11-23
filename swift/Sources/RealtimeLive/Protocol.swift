import Foundation

// Decision: nothing here touches the network, so it builds and tests on Linux too.

/// Any JSON value, for an event's `data`.
public enum JSONValue: Codable, Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let v = try? c.decode(Bool.self) { self = .bool(v) }
    else if let v = try? c.decode(Double.self) { self = .number(v) }
    else if let v = try? c.decode(String.self) { self = .string(v) }
    else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }
}

/// One event the server delivered: something was published to a topic you subscribed to.
public struct LiveEvent: Decodable, Equatable, Sendable {
  /// The `id` you gave when you subscribed.
  public let subscriptionId: String
  public let topic: String
  /// A label the publisher chose.
  public let type: String?
  /// An id the publisher chose. Keep it if you want to send it back as `lastEventId`.
  public let eventId: String?
  public let data: JSONValue?
}

/// Splits server-sent-event lines into frames. Feed it one line at a time, without its newline.
public struct SSEParser: Sendable {
  public enum Frame: Equatable, Sendable {
    case comment(String)
    case message(event: String, data: String)
  }

  private var event = ""
  private var data: [String] = []

  public init() {}

  /// A blank line ends a frame and returns it. A comment returns right away.
  public mutating func feed(_ line: String) -> Frame? {
    if line.isEmpty {
      defer { event = ""; data = [] }
      guard !data.isEmpty else { return nil }
      return .message(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
    }
    if line.hasPrefix(":") { return .comment(String(line.dropFirst()).trimmingCharacters(in: .whitespaces)) }
    let name: Substring
    var value: Substring
    if let colon = line.firstIndex(of: ":") {
      name = line[..<colon]
      value = line[line.index(after: colon)...]
      if value.first == " " { value = value.dropFirst() }
    } else {
      name = Substring(line)
      value = ""
    }
    switch name {
    case "event": event = String(value)
    case "data": data.append(String(value))
    default: break
    }
    return nil
  }

  /// The event a frame carries, or nil for comments and other kinds of frame.
  public static func liveEvent(from frame: Frame) -> LiveEvent? {
    guard case .message(let name, let data) = frame, name == "message" else { return nil }
    return try? JSONDecoder().decode(LiveEvent.self, from: Data(data.utf8))
  }
}

public enum LiveControl {
  public static let maxOperationsPerRequest = 100

  public enum Operation: Encodable, Equatable, Sendable {
    case subscribe(id: String, topic: String, lastEventId: String?)
    case unsubscribe(id: String)

    private enum Keys: String, CodingKey { case kind, id, topic, lastEventId }

    public func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: Keys.self)
      switch self {
      case .subscribe(let id, let topic, let lastEventId):
        try c.encode("subscribe", forKey: .kind)
        try c.encode(id, forKey: .id)
        try c.encode(topic, forKey: .topic)
        try c.encodeIfPresent(lastEventId, forKey: .lastEventId)
      case .unsubscribe(let id):
        try c.encode("unsubscribe", forKey: .kind)
        try c.encode(id, forKey: .id)
      }
    }
  }

  public static func body(connectionId: String, operations: [Operation]) throws -> Data {
    struct Body: Encodable { let connectionId: String; let operations: [Operation] }
    return try JSONEncoder().encode(Body(connectionId: connectionId, operations: operations))
  }

  public struct ErrorBody: Decodable, Equatable, Sendable {
    public let code: String
    public let message: String
  }

  public struct Result: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let kind: String
    public let id: String
    public let topic: String?
    public let error: ErrorBody?
  }

  public struct Response: Decodable, Equatable, Sendable {
    public let accepted: Bool
    public let results: [Result]?
    public let error: ErrorBody?
  }

  public static func response(from data: Data) -> Response? {
    try? JSONDecoder().decode(Response.self, from: data)
  }
}

public enum LiveBackoff {
  /// Seconds to wait before reconnect attempt `attempt` (0 is the first): 1, 2, 4, 8, 16, then 30.
  public static func seconds(attempt: Int) -> Double { min(30, pow(2, Double(min(max(attempt, 0), 5)))) }
}

public enum LiveError: Error, Equatable, Sendable {
  case badResponse
  case unauthorized
  case status(Int)
  /// The server answered the request as a whole with an error.
  case refused(code: String, message: String)
  /// The server refused one subscription.
  case rejected(id: String, code: String, message: String)
  case closed
}
