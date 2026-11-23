# RealtimeLive for Swift

A small client for a bwf live stream, for iOS and macOS apps that sign in with a bearer token. A browser's `EventSource` can't send an `Authorization` header, and neither can an app that has no cookie session. This client does the same job as `connectLiveStream` over `URLSession`.

The [protocol notes](../docs/live-protocol.md) describe what goes over the wire. This package is about 300 lines with no dependencies, so you could also copy it into your app.

## Add it

In Xcode, choose File > Add Package Dependencies and enter `https://github.com/builtbyfriends/realtime`. In a `Package.swift`:

```swift
.package(url: "https://github.com/builtbyfriends/realtime", from: "0.1.0")
// and, in the target:
.product(name: "RealtimeLive", package: "realtime")
```

## Use it

```swift
import RealtimeLive

let live = LiveClient(
  url: URL(string: "https://app.example.com/live")!,
  onUnauthorized: { await session.refresh() }
) {
  ["Authorization": "Bearer \(await session.accessToken())"]
}

try await live.subscribe(id: "wall", topic: "wall:123")
await live.start()

for await update in live.updates {
  switch update {
  case .event(let event): print(event.topic, event.type ?? "", event.data as Any)
  case .connected(let reconnect): if reconnect { await reload() }
  case .disconnected, .rejected: break
  }
}
```

- The headers closure runs for every request, so it can hand out a fresh token. When the stream answers 401 or 403, `onUnauthorized` runs and the client tries again after a short wait.
- `subscribe` before `start()` is fine. The client holds the subscriptions and sends them when the stream opens, and again after every reconnect.
- bwf replays nothing. After `.connected(reconnect: true)`, fetch again whatever the screen shows.
- `close()` ends the stream for good.

`LiveClient` needs `URLSession.bytes`, which Linux doesn't have, so it's left out there. The parser and request types in `Protocol.swift` build and test on Linux with `swift test`.
