package com.droidbridge.ui.product.mcp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject

enum class RelayUiStatus { Unpaired, Connecting, Connected, Offline }

data class RelaySettingsView(
    val status: RelayUiStatus,
    val paired: Boolean,
    val relayBase: String,
    val mcpUrl: String,
    val quickTunnelFallback: Boolean,
    val lastError: String? = null,
)

object RelaySettingsReplies {
    fun settings(reply: String): RelaySettingsView? = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        if (value.containsKey("error")) return null
        val status: RelayUiStatus = when (value.string("status")) {
            "unpaired" -> RelayUiStatus.Unpaired
            "connecting" -> RelayUiStatus.Connecting
            "connected" -> RelayUiStatus.Connected
            "offline" -> RelayUiStatus.Offline
            else -> throw IllegalArgumentException("status")
        }
        RelaySettingsView(
            status = status,
            paired = value.boolean("paired"),
            relayBase = value.string("relay_base"),
            mcpUrl = value.string("mcp_url"),
            quickTunnelFallback = value.boolean("quick_tunnel_fallback"),
            lastError = value.optionalString("last_error"),
        )
    }.getOrNull()

    fun error(reply: String): String? = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        (value["error"] as? JsonPrimitive)?.content
    }.getOrNull()

    private fun JsonObject.boolean(name: String): Boolean =
        requireNotNull((getValue(name) as JsonPrimitive).takeUnless { it.isString }?.booleanOrNull)

    private fun JsonObject.string(name: String): String =
        (getValue(name) as JsonPrimitive).also { require(it.isString) }.content

    private fun JsonObject.optionalString(name: String): String? =
        get(name)?.let { (it as JsonPrimitive).also { value -> require(value.isString) }.content }
}
