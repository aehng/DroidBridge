package com.droidbridge.standalone.runtimehost

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

internal const val RELAY_DEFAULT_BASE = "https://droid.synqra.info"
internal const val RELAY_MAX_FRAME_BYTES = 4 * 1024 * 1024
internal const val RELAY_PING_INTERVAL_MS = 25_000L
internal const val RELAY_INITIAL_BACKOFF_MS = 1_000L
internal const val RELAY_MAX_BACKOFF_MS = 60_000L

internal sealed class RelayInbound {
    data class Rpc(
        val id: String,
        val body: JsonElement,
        val headers: Map<String, String>,
    ) : RelayInbound()

    data class Pong(val t: Long) : RelayInbound()

    data object Revoked : RelayInbound()
}

internal object RelayProtocol {
    private val json = Json { ignoreUnknownKeys = true }

    fun nextBackoffMs(currentMs: Long, jitterUnit: Double): Long {
        val unit = jitterUnit.coerceIn(0.0, 1.0)
        val base = if (currentMs < RELAY_INITIAL_BACKOFF_MS) RELAY_INITIAL_BACKOFF_MS else currentMs
        val doubled = minOf(RELAY_MAX_BACKOFF_MS, saturatingMultiply(base, 2))
        val jittered = (doubled * (0.75 + unit * 0.5)).toLong()
        return jittered.coerceIn(RELAY_INITIAL_BACKOFF_MS, RELAY_MAX_BACKOFF_MS)
    }

    fun parseInbound(text: String): RelayInbound {
        require(text.length <= RELAY_MAX_FRAME_BYTES)
        val obj = json.parseToJsonElement(text).jsonObject
        return when (obj.string("type")) {
            "rpc" -> RelayInbound.Rpc(
                id = obj.string("id"),
                body = obj.getValue("body"),
                headers = obj.headers(),
            )
            "pong" -> RelayInbound.Pong(obj.getValue("t").jsonPrimitive.long)
            "revoked" -> RelayInbound.Revoked
            else -> error("unknown frame type")
        }
    }

    fun ping(t: Long): String = buildJsonObject {
        put("type", "ping")
        put("t", t)
    }.toString()

    fun rpcResult(
        id: String,
        status: Int,
        body: JsonElement?,
        sessionId: String?,
    ): String = buildJsonObject {
        put("type", "rpc_result")
        put("id", id)
        put("status", status)
        if (body == null) put("body", JsonNull) else put("body", body)
        put(
            "headers",
            buildJsonObject {
                if (!sessionId.isNullOrEmpty()) put("mcp-session-id", sessionId)
            },
        )
    }.toString()

    private fun saturatingMultiply(value: Long, factor: Long): Long {
        val product = value * factor
        return if (value != 0L && product / value != factor) Long.MAX_VALUE else product
    }

    private fun JsonObject.string(name: String): String =
        getValue(name).jsonPrimitive.content

    private fun JsonObject.headers(): Map<String, String> {
        val raw = get("headers") as? JsonObject ?: return emptyMap()
        return raw.mapNotNull { (key, value) ->
            val text = value.jsonPrimitive.contentOrNull ?: return@mapNotNull null
            key to text
        }.toMap()
    }
}

internal data class RelayPairSuccess(
    val deviceToken: String,
    val accountId: String,
    val mcpUrl: String,
)

internal sealed class RelayPairOutcome {
    data class Ok(val success: RelayPairSuccess) : RelayPairOutcome()
    data class Err(val status: Int, val message: String) : RelayPairOutcome()
}

internal object RelayPairing {
    private val tokenPattern = Regex("^dbt_[A-Za-z0-9_-]{32,}$")
    private val codePattern = Regex("^[A-Z2-9]{8}$")

    fun isPairCode(code: String): Boolean = codePattern.matches(code.trim().uppercase())

    fun normalizeCode(code: String): String = code.trim().uppercase()

    fun parseResponse(status: Int, body: String): RelayPairOutcome {
        val obj = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrElse {
            return RelayPairOutcome.Err(status, "invalid_json")
        }
        if (status == 200) {
            val token = obj.stringOrEmpty("deviceToken")
            val accountId = obj.stringOrEmpty("accountId")
            val mcpUrl = obj.stringOrEmpty("mcpUrl")
            if (!tokenPattern.matches(token) || accountId.isEmpty() || mcpUrl.isEmpty()) {
                return RelayPairOutcome.Err(status, "invalid_pair_payload")
            }
            return RelayPairOutcome.Ok(RelayPairSuccess(token, accountId, mcpUrl))
        }
        val message = obj.stringOrEmpty("error").ifEmpty { "pair_failed" }
        return RelayPairOutcome.Err(status, message)
    }

    private fun JsonObject.stringOrEmpty(name: String): String =
        (get(name) as? JsonPrimitive)?.content.orEmpty()
}

internal fun relayWsUrl(httpsBase: String): String {
    val trimmed = httpsBase.trimEnd('/')
    val ws = when {
        trimmed.startsWith("https://") -> "wss://" + trimmed.removePrefix("https://")
        trimmed.startsWith("http://") -> "ws://" + trimmed.removePrefix("http://")
        else -> "wss://$trimmed"
    }
    return "$ws/device/ws"
}

internal fun relayMcpUrl(httpsBase: String): String = httpsBase.trimEnd('/') + "/mcp"

internal fun relayPairUrl(httpsBase: String): String = httpsBase.trimEnd('/') + "/device/pair"
