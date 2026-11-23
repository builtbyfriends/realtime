package com.builtbyfriends.realtime.live

import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Listens to a bwf live stream with a bearer token (or any headers) over OkHttp.
 *
 *     val live = LiveClient(
 *         url = "https://app.example.com/live",
 *         scope = appScope,
 *         onUnauthorized = { session.refresh() },
 *         headers = { mapOf("Authorization" to "Bearer ${session.accessToken()}") },
 *     )
 *     live.subscribe("wall", "wall:123")
 *     live.start()
 *     scope.launch { live.events.collect { reload() } }
 *     scope.launch { live.reconnects.collect { reload() } }
 *
 * bwf delivers at most once and replays nothing, so a value on [reconnects] means events may have
 * been missed while the stream was down. Fetch again when you see one.
 *
 * @param url The route that exports `live.connect` and `live.control`, for example `https://app.example.com/live`.
 * @param headers Called for every request, so it can return a fresh token each time.
 * @param onUnauthorized Called when the stream answers 401 or 403 (an expired or missing token), before the client tries again. Refresh the token here.
 * @param retryMillis How long to wait before reconnect attempt `n`, counting from 0.
 */
class LiveClient(
    url: String,
    private val scope: CoroutineScope,
    http: OkHttpClient = OkHttpClient(),
    private val headers: suspend () -> Map<String, String> = { emptyMap() },
    private val onUnauthorized: suspend () -> Unit = {},
    private val retryMillis: (attempt: Int) -> Long = ::liveBackoffMillis,
) {
    // Decision: the server sends a keep-alive every 15 seconds, so a quiet minute means the connection is dead.
    private val http = http.newBuilder().readTimeout(60, TimeUnit.SECONDS).build()
    private val url = url.toHttpUrl()
    private val connectionId = UUID.randomUUID().toString()
    private val subscriptions = ConcurrentHashMap<String, Subscription>()

    private class Subscription(val topic: String, @Volatile var lastEventId: String?)

    /** True while the stream is open and its subscriptions are in place. */
    val connected: StateFlow<Boolean> get() = connectedState
    private val connectedState = MutableStateFlow(false)

    /** The failure that ended the last attempt to keep the stream open, or null. Cleared when the stream opens. */
    val lastError: StateFlow<Throwable?> get() = lastErrorState
    private val lastErrorState = MutableStateFlow<Throwable?>(null)

    val events: SharedFlow<LiveEvent> = MutableSharedFlow(extraBufferCapacity = 256, onBufferOverflow = BufferOverflow.SUSPEND)
    private val eventsOut get() = events as MutableSharedFlow<LiveEvent>

    /** One value each time the stream opens again after a drop. Events may have been missed: fetch again. */
    val reconnects: SharedFlow<Unit> = MutableSharedFlow(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val reconnectsOut get() = reconnects as MutableSharedFlow<Unit>

    /** A subscription the server refused while the client was restoring it after a reconnect. */
    val rejections: SharedFlow<LiveControl.Result> = MutableSharedFlow(extraBufferCapacity = 16, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private val rejectionsOut get() = rejections as MutableSharedFlow<LiveControl.Result>

    @Volatile private var open = false
    private var hasOpened = false
    private var job: Job? = null
    @Volatile private var closed = false

    /** Opens the stream, and keeps it open, until [close]. Calling it again does nothing. */
    @Synchronized
    fun start() {
        if (job != null || closed) return
        job = scope.launch(Dispatchers.IO) { run() }
    }

    /**
     * Subscribes. With the same [id] it replaces the earlier subscription. Before the stream is open,
     * the subscription is held and sent on open. While open, this throws [LiveException.Rejected]
     * if the server refuses it.
     */
    suspend fun subscribe(id: String, topic: String, lastEventId: String? = null) {
        check(!closed) { "live: client is closed" }
        val previous = subscriptions.put(id, Subscription(topic, lastEventId))
        if (!open) return
        try {
            val failed = send(listOf(LiveControl.Operation.Subscribe(id, topic, lastEventId))).firstOrNull { !it.ok }
            if (failed != null) throw LiveException.Rejected(id, failed.error?.code.orEmpty(), failed.error?.message.orEmpty())
        } catch (e: Exception) {
            if (previous != null) subscriptions[id] = previous else subscriptions.remove(id)
            throw e
        }
    }

    suspend fun unsubscribe(id: String) {
        if (subscriptions.remove(id) == null || !open) return
        send(listOf(LiveControl.Operation.Unsubscribe(id)))
    }

    /** Stops listening for good. Make a new client to listen again. */
    @Synchronized
    fun close() {
        closed = true
        job?.cancel()
        job = null
        subscriptions.clear()
        open = false
        connectedState.value = false
    }

    @Synchronized
    private fun markOpen() {
        if (closed) throw CancellationException("live: client is closed")
        open = true
    }

    @Synchronized
    private fun markConnected(reconnect: Boolean) {
        if (closed) throw CancellationException("live: client is closed")
        connectedState.value = true
        lastErrorState.value = null
        if (reconnect) reconnectsOut.tryEmit(Unit)
    }

    @Synchronized
    private fun recordFailure(e: Exception) {
        if (!closed) lastErrorState.value = e
    }

    private suspend fun run() {
        var attempt = 0
        while (scope.isActive && !closed) {
            try {
                listen { attempt = 0 }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                recordFailure(e)
            }
            open = false
            connectedState.value = false
            currentCoroutineContext().ensureActive()
            delay(retryMillis(attempt))
            attempt++
        }
    }

    private suspend fun listen(onAlive: () -> Unit) = withContext(Dispatchers.IO) {
        val call = http.newCall(
            Request.Builder()
                .url(url.newBuilder().addQueryParameter("connectionId", connectionId).build())
                .header("Accept", "text/event-stream")
                .apply { headers().forEach { (name, value) -> header(name, value) } }
                .get().build(),
        )
        coroutineScope {
            // Decision: a child that waits for cancellation, because Job.invokeOnCompletion only fires once the job has finished, which a blocked execute() prevents.
            val watcher = launch { try { awaitCancellation() } finally { call.cancel() } }
            try {
            call.execute().use { response ->
                if (response.code == 401 || response.code == 403) { onUnauthorized(); throw LiveException.Unauthorized(response.code) }
                if (response.code != 200) throw LiveException.Status(response.code)
                val source = response.body!!.source()

                val reconnect = hasOpened
                hasOpened = true
                markOpen()
                restoreSubscriptions()
                markConnected(reconnect)

                val parser = SseParser()
                var alive = false
                while (true) {
                    ensureActive()
                    val line = source.readUtf8Line() ?: break
                    if (!alive) { alive = true; onAlive() }
                    val event = parser.feed(line)?.let(SseParser::liveEvent) ?: continue
                    val held = subscriptions[event.subscriptionId]?.takeIf { it.topic == event.topic } ?: continue
                    event.eventId?.let { held.lastEventId = it }
                    eventsOut.emit(event)
                }
            }
            } finally {
                watcher.cancel()
            }
        }
    }

    private suspend fun restoreSubscriptions() {
        val operations = subscriptions.map { (id, s) -> LiveControl.Operation.Subscribe(id, s.topic, s.lastEventId) }
        if (operations.isEmpty()) return
        send(operations).filter { !it.ok }.forEach { rejectionsOut.tryEmit(it) }
    }

    private suspend fun send(operations: List<LiveControl.Operation>): List<LiveControl.Result> = withContext(Dispatchers.IO) {
        val results = mutableListOf<LiveControl.Result>()
        for (chunk in operations.chunked(LiveControl.MAX_OPERATIONS_PER_REQUEST)) {
            val request = Request.Builder().url(url)
                .apply { headers().forEach { (name, value) -> header(name, value) } }
                .post(LiveControl.body(connectionId, chunk).toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(request).execute().use { response ->
                if (response.code == 401) { onUnauthorized(); throw LiveException.Unauthorized() }
                val answer = LiveControl.response(response.body?.string().orEmpty())
                if (answer?.accepted != true) {
                    val error = answer?.error
                    throw if (error != null) LiveException.Refused(error.code, error.message) else LiveException.Status(response.code)
                }
                results += answer.results
            }
        }
        results
    }
}
