# realtime-live for Kotlin

A small client for a bwf live stream, for Android and JVM apps that sign in with a bearer token. A browser's `EventSource` can't send an `Authorization` header, and neither can an app that has no cookie session. This client does the same job as `connectLiveStream` over OkHttp.

The [protocol notes](../docs/live-protocol.md) describe what goes over the wire. This module is two files with OkHttp, coroutines and kotlinx.serialization as its only dependencies, so you could also copy `Protocol.kt` and `LiveClient.kt` into your app.

It's a plain JVM library, so it works in an Android app as it is. `gradle test` runs its tests against a fake server.

## Add it

The client is published by [JitPack](https://jitpack.io), which builds a tag of this repository on demand.

```kotlin
// settings.gradle.kts
dependencyResolutionManagement { repositories { maven("https://jitpack.io") } }

// build.gradle.kts
implementation("com.github.builtbyfriends:realtime:<tag or commit>")
```

## Use it

```kotlin
val live = LiveClient(
    url = "https://app.example.com/live",
    scope = appScope,
    http = okHttpClient,
    onUnauthorized = { session.refresh() },
    headers = { mapOf("Authorization" to "Bearer ${session.accessToken()}") },
)

live.subscribe("wall", "wall:123")
live.start()

appScope.launch { live.events.collect { event -> println("${event.topic} ${event.type}") } }
appScope.launch { live.reconnects.collect { reload() } }
```

- The `headers` function runs for every request, so it can hand out a fresh token. When the stream answers 401 or 403, `onUnauthorized` runs and the client tries again after a short wait.
- `subscribe` before `start()` is fine. The client holds the subscriptions and sends them when the stream opens, and again after every reconnect. Once the stream is open, `subscribe` throws `LiveException.Rejected` if the server refuses the topic.
- bwf replays nothing. When `reconnects` emits, fetch again whatever the screen shows.
- `connected` is a `StateFlow<Boolean>`, handy for a slow fallback poll while the stream is down.
- `lastError` is a `StateFlow<Throwable?>` with the failure that ended the last attempt (a status error, a dropped connection), and goes back to null when the stream opens. Use it to log or show why the stream is down.
- The retry wait starts over only after the stream has sent a first line, so a server that accepts and then drops is retried with a growing wait.
- `close()` ends the stream for good.
