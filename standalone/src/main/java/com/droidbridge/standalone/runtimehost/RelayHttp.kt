package com.droidbridge.standalone.runtimehost

import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.json.JSONObject

internal data class LocalMcpResponse(
    val status: Int,
    val body: JsonElement?,
    val sessionId: String?,
)

internal object RelayHttp {
    private val json = Json { ignoreUnknownKeys = true }

    fun pair(relayBase: String, code: String, deviceName: String): RelayPairOutcome {
        val payload = JSONObject()
            .put("code", RelayPairing.normalizeCode(code))
            .put("deviceName", deviceName)
            .toString()
        val connection = (URL(relayPairUrl(relayBase)).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 15_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
        }
        return try {
            connection.outputStream.use { it.write(payload.toByteArray(StandardCharsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.use { it.readBytes().toString(StandardCharsets.UTF_8) }.orEmpty()
            RelayPairing.parseResponse(status, body)
        } catch (error: Exception) {
            RelayPairOutcome.Err(0, error.message ?: "network_error")
        } finally {
            connection.disconnect()
        }
    }

    fun postLocalMcp(
        port: Int,
        pathToken: String,
        body: JsonElement,
        headers: Map<String, String>,
    ): LocalMcpResponse {
        val url = URL("http://127.0.0.1:$port/mcp/$pathToken")
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 5_000
            readTimeout = 50_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json, text/event-stream")
            setRequestProperty("Host", "127.0.0.1:$port")
            headers["mcp-session-id"]?.let { setRequestProperty("Mcp-Session-Id", it) }
            headers["mcp-protocol-version"]?.let { setRequestProperty("MCP-Protocol-Version", it) }
            headers["mcp-method"]?.let { setRequestProperty("Mcp-Method", it) }
            headers["mcp-name"]?.let { setRequestProperty("Mcp-Name", it) }
        }
        return try {
            val payload = body.toString().toByteArray(StandardCharsets.UTF_8)
            connection.outputStream.use { it.write(payload) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val raw = stream?.use { it.readBytes().toString(StandardCharsets.UTF_8) }.orEmpty()
            val session = connection.getHeaderField("Mcp-Session-Id")
                ?: connection.getHeaderField("mcp-session-id")
            val parsed = if (raw.isBlank()) {
                JsonNull
            } else {
                runCatching { json.parseToJsonElement(raw) }.getOrDefault(JsonNull)
            }
            LocalMcpResponse(status, parsed, session)
        } catch (error: Exception) {
            LocalMcpResponse(503, json.parseToJsonElement("""{"error":"${error.javaClass.simpleName}"}"""), null)
        } finally {
            connection.disconnect()
        }
    }
}
