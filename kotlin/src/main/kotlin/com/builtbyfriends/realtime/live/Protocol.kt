package com.builtbyfriends.realtime.live

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// Decision: the wire protocol is docs/live-protocol.md. Keep this file in step with it.

/** One event the server delivered: something was published to a topic you subscribed to. */
data class LiveEvent(
    /** The `id` you gave when you subscribed. */
    val subscriptionId: String,
    val topic: String,
    /** A label the publisher chose. */
    val type: String? = null,
    /** An id the publisher chose. Keep it if you want to send it back as `lastEventId`. */
    val eventId: String? = null,
    /** The payload. Any JSON. */
    val data: JsonElement? = null,
)

/** A frame from the stream: a comment, or a named message. */
sealed interface SseFrame {
    data class Comment(val text: String) : SseFrame
    data class Message(val event: String, val data: String) : SseFrame
}

/** Splits server-sent-event lines into frames. Feed it one line at a time, without its newline. */
class SseParser {
    private var event = ""
    private val data = mutableListOf<String>()

    /** A blank line ends a frame and returns it. A comment returns right away. */
    fun feed(line: String): SseFrame? {
        if (line.isEmpty()) {
            val frame = if (data.isEmpty()) null else SseFrame.Message(event.ifEmpty { "message" }, data.joinToString("\n"))
            event = ""
            data.clear()
            return frame
        }
        if (line.startsWith(":")) return SseFrame.Comment(line.drop(1).trim())
        val colon = line.indexOf(':')
        val name = if (colon == -1) line else line.substring(0, colon)
        val value = if (colon == -1) "" else line.substring(colon + 1).removePrefix(" ")
        when (name) {
            "event" -> event = value
            "data" -> data += value
        }
        return null
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** The event a frame carries, or null for comments and other kinds of frame. */
        fun liveEvent(frame: SseFrame): LiveEvent? {
            if (frame !is SseFrame.Message || frame.event != "message") return null
            val obj = runCatching { json.parseToJsonElement(frame.data).jsonObject }.getOrNull() ?: return null
            val subscriptionId = obj.string("subscriptionId") ?: return null
            val topic = obj.string("topic") ?: return null
            return LiveEvent(subscriptionId, topic, obj.string("type"), obj.string("eventId"), obj["data"])
        }

        private fun JsonObject.string(key: String) = (get(key) as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
    }
}

/** The subscribe and unsubscribe request, and its answer. */
object LiveControl {
    const val MAX_OPERATIONS_PER_REQUEST = 100

    sealed interface Operation {
        data class Subscribe(val id: String, val topic: String, val lastEventId: String? = null) : Operation
        data class Unsubscribe(val id: String) : Operation
    }

    data class Error(val code: String, val message: String)

    data class Result(val ok: Boolean, val kind: String, val id: String, val topic: String?, val error: Error?)

    /** `accepted` is false when the server refused the request as a whole; then `error` says why. */
    data class Response(val accepted: Boolean, val results: List<Result>, val error: Error?)

    /** The JSON body of a control POST. */
    fun body(connectionId: String, operations: List<Operation>): String = buildJsonObject {
        put("connectionId", connectionId)
        put("operations", buildJsonArray {
            for (op in operations) add(buildJsonObject {
                when (op) {
                    is Operation.Subscribe -> {
                        put("kind", "subscribe"); put("id", op.id); put("topic", op.topic)
                        op.lastEventId?.let { put("lastEventId", it) }
                    }
                    is Operation.Unsubscribe -> { put("kind", "unsubscribe"); put("id", op.id) }
                }
            })
        })
    }.toString()

    fun response(text: String): Response? = runCatching {
        val obj = Json.parseToJsonElement(text).jsonObject
        Response(
            accepted = obj["accepted"]?.jsonPrimitive?.content == "true",
            results = (obj["results"] as? kotlinx.serialization.json.JsonArray).orEmpty().map { r ->
                val o = r.jsonObject
                Result(
                    ok = o["ok"]?.jsonPrimitive?.content == "true",
                    kind = o["kind"]?.jsonPrimitive?.content.orEmpty(),
                    id = o["id"]?.jsonPrimitive?.content.orEmpty(),
                    topic = o["topic"]?.jsonPrimitive?.contentOrNull,
                    error = (o["error"] as? JsonObject)?.error(),
                )
            },
            error = (obj["error"] as? JsonObject)?.error(),
        )
    }.getOrNull()

    private fun JsonObject.error() = Error(get("code")?.jsonPrimitive?.content.orEmpty(), get("message")?.jsonPrimitive?.content.orEmpty())
}

/** Milliseconds to wait before reconnect attempt `attempt` (0 is the first): 1, 2, 4, 8, 16, then 30 seconds. */
fun liveBackoffMillis(attempt: Int): Long = minOf(1_000L shl attempt.coerceIn(0, 5), 30_000L)

/** What can go wrong talking to a live stream. */
sealed class LiveException(message: String) : Exception(message) {
    class Unauthorized(val status: Int = 401) : LiveException("live: the server answered $status")
    class Status(val status: Int) : LiveException("live: the server answered $status")

    /** The server refused the request as a whole. */
    class Refused(val code: String, message: String) : LiveException(message)

    /** The server refused one subscription. */
    class Rejected(val id: String, val code: String, message: String) : LiveException(message)
}
