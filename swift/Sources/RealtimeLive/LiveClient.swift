#if !canImport(FoundationNetworking)
import Foundation

/// Listens to a bwf live stream with a bearer token (or any headers) over `URLSession`.
///
///     let live = LiveClient(url: URL(string: "https://app.example.com/live")!) {
///       ["Authorization": "Bearer \(await tokens.current())"]
///     }
///     try await live.subscribe(id: "wall", topic: "wall:123")
///     live.start()
///     for await update in live.updates {
///       switch update {
///       case .event: refetch()
///       case .connected(let reconnect): if reconnect { refetch() }
///       case .disconnected, .rejected: break
///       }
///     }
///
/// bwf delivers at most once and replays nothing, so a `.connected(reconnect: true)` update means
/// events may have been missed while the stream was down. Fetch again when you see it.
public actor LiveClient {
  public enum Update: Sendable {
    /// The stream is open and every subscription is in place. `reconnect` is false the first time.
    case connected(reconnect: Bool)
    /// The stream ended or failed. The client opens it again by itself.
    case disconnected
    case event(LiveEvent)
    /// The server refused a subscription while the client was restoring it after a reconnect.
    case rejected(id: String, code: String, message: String)
  }

  /// Everything that happens on the stream. The sequence ends when the client is closed.
  public nonisolated let updates: AsyncStream<Update>

  /// True while the stream is open.
  public private(set) var isConnected = false

  private struct Subscription { let topic: String; var lastEventId: String? }

  private let url: URL
  private let headers: @Sendable () async throws -> [String: String]
  private let onUnauthorized: (@Sendable () async -> Void)?
  private let session: URLSession
  private let connectionId = UUID().uuidString
  private let continuation: AsyncStream<Update>.Continuation
  private var subscriptions: [String: Subscription] = [:]
  private var task: Task<Void, Never>?
  private var hasOpened = false
  private var closed = false

  /// - Parameters:
  ///   - url: The route that exports `live.connect` and `live.control`, for example `https://app.example.com/live`.
  ///   - headers: Called for every request, so it can return a fresh token each time.
  ///   - onUnauthorized: Called when the server answers 401 or 403 on the stream, before the client tries again. Refresh the token here.
  ///   - session: Defaults to a session whose idle timeout is 60 seconds. The server sends a keep-alive every 15.
  public init(
    url: URL,
    session: URLSession? = nil,
    onUnauthorized: (@Sendable () async -> Void)? = nil,
    headers: @escaping @Sendable () async throws -> [String: String]
  ) {
    self.url = url
    self.headers = headers
    self.onUnauthorized = onUnauthorized
    if let session {
      self.session = session
    } else {
      let configuration = URLSessionConfiguration.default
      configuration.timeoutIntervalForRequest = 60
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      self.session = URLSession(configuration: configuration)
    }
    var made: AsyncStream<Update>.Continuation!
    updates = AsyncStream(bufferingPolicy: .unbounded) { made = $0 }
    continuation = made
  }

  /// Opens the stream, and keeps it open, until `close()`. Calling it again does nothing.
  public func start() {
    guard task == nil, !closed else { return }
    task = Task { [weak self] in await self?.run() }
  }

  /// Subscribes. With the same `id` it replaces the earlier subscription. Before the stream is open,
  /// the subscription is held and sent on open. While open, this throws if the server refuses it.
  public func subscribe(id: String, topic: String, lastEventId: String? = nil) async throws {
    guard !closed else { throw LiveError.closed }
    let previous = subscriptions[id]
    subscriptions[id] = Subscription(topic: topic, lastEventId: lastEventId)
    guard isConnected else { return }
    do {
      let results = try await send([.subscribe(id: id, topic: topic, lastEventId: lastEventId)])
      if let failed = results.first(where: { !$0.ok }) {
        throw LiveError.rejected(id: id, code: failed.error?.code ?? "", message: failed.error?.message ?? "")
      }
    } catch {
      subscriptions[id] = previous
      throw error
    }
  }

  public func unsubscribe(id: String) async throws {
    guard subscriptions.removeValue(forKey: id) != nil, isConnected else { return }
    _ = try await send([.unsubscribe(id: id)])
  }

  /// Stops listening for good. Make a new `LiveClient` to listen again.
  public func close() {
    closed = true
    task?.cancel()
    task = nil
    subscriptions = [:]
    continuation.finish()
  }

  private func run() async {
    var attempt = 0
    while !Task.isCancelled {
      do {
        try await listen(onAlive: { attempt = 0 })
      } catch is CancellationError {
        break
      } catch {}
      let wasConnected = isConnected
      isConnected = false
      if closed { break }
      if wasConnected { continuation.yield(.disconnected) }
      try? await Task.sleep(nanoseconds: UInt64(LiveBackoff.seconds(attempt: attempt) * 1_000_000_000))
      attempt += 1
    }
  }

  private func listen(onAlive: () -> Void) async throws {
    var request = URLRequest(url: streamURL())
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    try await applyHeaders(to: &request)
    let (bytes, response) = try await session.bytes(for: request)
    let status = try Self.status(of: response)
    if status == 401 || status == 403 { await onUnauthorized?(); throw LiveError.unauthorized }
    guard status == 200 else { throw LiveError.status(status) }

    let reconnect = hasOpened
    hasOpened = true
    isConnected = true
    try await restoreSubscriptions()
    continuation.yield(.connected(reconnect: reconnect))

    // Decision: `AsyncBytes.lines` drops blank lines, and a blank line is what ends a frame, so split by hand.
    var parser = SSEParser()
    var line = Data()
    var alive = false
    for try await byte in bytes {
      guard byte == 10 else { line.append(byte); continue }
      // Decision: the wait between attempts starts over once the stream sends a line. A server that answers 200 and then
      // drops the stream would otherwise be tried again each second.
      if !alive { alive = true; onAlive() }
      if line.last == 13 { line.removeLast() }
      let text = String(decoding: line, as: UTF8.self)
      line.removeAll(keepingCapacity: true)
      guard let frame = parser.feed(text), let event = SSEParser.liveEvent(from: frame) else { continue }
      guard subscriptions[event.subscriptionId]?.topic == event.topic else { continue }
      if let eventId = event.eventId { subscriptions[event.subscriptionId]?.lastEventId = eventId }
      continuation.yield(.event(event))
    }
    throw URLError(.networkConnectionLost)
  }

  private func restoreSubscriptions() async throws {
    let operations = subscriptions.map { LiveControl.Operation.subscribe(id: $0.key, topic: $0.value.topic, lastEventId: $0.value.lastEventId) }
    guard !operations.isEmpty else { return }
    for result in try await send(operations) where !result.ok {
      continuation.yield(.rejected(id: result.id, code: result.error?.code ?? "", message: result.error?.message ?? ""))
    }
  }

  private func streamURL() -> URL {
    var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
    components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "connectionId", value: connectionId)]
    return components.url!
  }

  private func applyHeaders(to request: inout URLRequest) async throws {
    for (name, value) in try await headers() { request.setValue(value, forHTTPHeaderField: name) }
  }

  private func send(_ operations: [LiveControl.Operation]) async throws -> [LiveControl.Result] {
    var results: [LiveControl.Result] = []
    var rest = operations[...]
    while !rest.isEmpty {
      let chunk = Array(rest.prefix(LiveControl.maxOperationsPerRequest))
      rest = rest.dropFirst(chunk.count)
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      try await applyHeaders(to: &request)
      let (data, response) = try await session.upload(for: request, from: try LiveControl.body(connectionId: connectionId, operations: chunk))
      let status = try Self.status(of: response)
      if status == 401 { await onUnauthorized?(); throw LiveError.unauthorized }
      let answer = LiveControl.response(from: data)
      if answer?.accepted != true {
        if let error = answer?.error { throw LiveError.refused(code: error.code, message: error.message) }
        throw LiveError.status(status)
      }
      results += answer?.results ?? []
    }
    return results
  }

  private static func status(of response: URLResponse) throws -> Int {
    guard let http = response as? HTTPURLResponse else { throw LiveError.badResponse }
    return http.statusCode
  }
}
#endif
