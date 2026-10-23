package com.droidbridge.ui.product.mcp

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

enum class TunnelRuntimeState { Stopped, Connecting, Running, Failed }

enum class TunnelSettingsError { TunnelNotFound, ApiKeyInvalid, OpenAiUnavailable, InvalidConfig, IoError, NotConfigured }

data class TunnelSettingsView(
    val configured: Boolean,
    val enabled: Boolean,
    val state: TunnelRuntimeState,
    val tunnelId: String? = null,
    val reason: String? = null,
    val lastCallEpochMs: Long? = null,
    /** The control plane's last failure token while the tunnel is not running, e.g. `http_401`. */
    val lastError: String? = null,
    val mode: String = "quick",
    val url: String? = null,
    val protocolVersion: String,
) {
    fun connectorUrl(secret: String?): String? {
        val base = url?.trimEnd('/') ?: return null
        val token = secret?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return "$base/mcp/$token"
    }
}

const val OPENAI_TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels"
const val OPENAI_API_KEYS_URL = "https://platform.openai.com/api-keys"
const val CHATGPT_DEVELOPER_SETTINGS_URL = "https://chatgpt.com/settings/security"
const val CHATGPT_PLUGINS_URL = "https://chatgpt.com/plugins"

fun isTunnelPluginCreationReady(
    runtimeReady: Boolean,
    tunnelState: TunnelRuntimeState,
): Boolean = runtimeReady && tunnelState == TunnelRuntimeState.Running

fun isTunnelStepActionEnabled(firstConfiguration: Boolean, prerequisiteMet: Boolean): Boolean =
    !firstConfiguration || prerequisiteMet

fun isTunnelConfigurationInputValid(tunnelId: String, apiKey: String): Boolean =
    TUNNEL_ID.matches(tunnelId) &&
        apiKey.isNotEmpty() &&
        apiKey.length <= 512 &&
        apiKey.all { it.code in 0x21..0x7e }

object TunnelSettingsReplies {
    fun settings(reply: String): TunnelSettingsView? = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        require(!value.containsKey("api_key") && !value.containsKey("secret") && !value.containsKey("token"))
        val state = when (value.string("state")) {
            "stopped" -> TunnelRuntimeState.Stopped
            "connecting" -> TunnelRuntimeState.Connecting
            "running" -> TunnelRuntimeState.Running
            "failed" -> TunnelRuntimeState.Failed
            else -> kotlin.error("state")
        }
        val configured = value.boolean("configured")
        val enabled = value.boolean("enabled")
        val reason = value.optionalString("reason")
        val lastCallEpochMs = value.optionalLong("last_call_epoch_ms")
        val lastError = value.optionalString("last_error")
        val mode = value.optionalString("mode") ?: "quick"
        val url = value.optionalString("url")
        val tunnelId = value.optionalString("tunnel_id")

        val expected = buildSet {
            addAll(setOf("schema_version", "configured", "enabled", "state", "protocol_version"))
            if (tunnelId != null) add("tunnel_id")
            if (reason != null) add("reason")
            if (lastCallEpochMs != null) add("last_call_epoch_ms")
            if (lastError != null) add("last_error")
            if (value.containsKey("mode")) add("mode")
            if (value.containsKey("url")) add("url")
        }
        require(value.keys == expected && value.version())
        require(configured || (!enabled && state == TunnelRuntimeState.Stopped))
        require(enabled || state == TunnelRuntimeState.Stopped)
        require((state == TunnelRuntimeState.Failed) == (reason != null || lastError != null))

        TunnelSettingsView(
            configured = configured,
            enabled = enabled,
            state = state,
            tunnelId = tunnelId,
            reason = reason,
            lastCallEpochMs = lastCallEpochMs,
            lastError = lastError,
            mode = mode,
            url = url,
            protocolVersion = value.string("protocol_version"),
        )
    }.getOrNull()

    fun error(reply: String): TunnelSettingsError? = runCatching {
        val value = Json.parseToJsonElement(reply).jsonObject
        require(value.keys == setOf("schema_version", "error") && value.version())
        when (value.string("error")) {
            "TUNNEL_NOT_FOUND" -> TunnelSettingsError.TunnelNotFound
            "API_KEY_INVALID" -> TunnelSettingsError.ApiKeyInvalid
            "OPENAI_UNAVAILABLE" -> TunnelSettingsError.OpenAiUnavailable
            "INVALID_CONFIG" -> TunnelSettingsError.InvalidConfig
            "IO_ERROR" -> TunnelSettingsError.IoError
            "NOT_CONFIGURED" -> TunnelSettingsError.NotConfigured
            else -> error("unknown tunnel settings error")
        }
    }.getOrNull()

    private fun JsonObject.version(): Boolean =
        (get("schema_version") as? JsonPrimitive)?.let { !it.isString && it.content == "1" } == true

    private fun JsonObject.boolean(name: String): Boolean =
        requireNotNull((getValue(name) as JsonPrimitive).takeUnless { it.isString }?.booleanOrNull)

    private fun JsonObject.string(name: String): String =
        (getValue(name) as JsonPrimitive).also { require(it.isString) }.content

    private fun JsonObject.optionalString(name: String): String? =
        get(name)?.let { (it as JsonPrimitive).also { value -> require(value.isString) }.content }

    private fun JsonObject.optionalLong(name: String): Long? =
        get(name)?.let { requireNotNull((it as JsonPrimitive).takeUnless(JsonPrimitive::isString)?.longOrNull) }
            ?.also { require(it > 0) }
}

private val TUNNEL_ID = Regex("tunnel_[a-z0-9]{32}")