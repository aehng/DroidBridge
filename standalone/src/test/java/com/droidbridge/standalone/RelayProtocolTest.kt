package com.droidbridge.standalone

import com.droidbridge.standalone.runtimehost.RELAY_INITIAL_BACKOFF_MS
import com.droidbridge.standalone.runtimehost.RELAY_MAX_BACKOFF_MS
import com.droidbridge.standalone.runtimehost.RelayInbound
import com.droidbridge.standalone.runtimehost.RelayPairOutcome
import com.droidbridge.standalone.runtimehost.RelayPairing
import com.droidbridge.standalone.runtimehost.RelayProtocol
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayProtocolTest {
    @Test
    fun parse_rpc_frame_and_headers() {
        val inbound = RelayProtocol.parseInbound(
            """{"type":"rpc","id":"11111111-2222-4333-8444-555555555555","body":{"jsonrpc":"2.0","id":1,"method":"ping"},"headers":{"mcp-session-id":"sess","mcp-protocol-version":"2025-11-25"}}""",
        )
        val rpc = inbound as RelayInbound.Rpc
        assertEquals("11111111-2222-4333-8444-555555555555", rpc.id)
        assertEquals("ping", rpc.body.jsonObject["method"]?.jsonPrimitive?.content)
        assertEquals("sess", rpc.headers["mcp-session-id"])
        assertEquals("2025-11-25", rpc.headers["mcp-protocol-version"])
    }

    @Test
    fun serialize_rpc_result_and_ping() {
        val result = RelayProtocol.rpcResult("abc", 200, JsonNull, "sess")
        assertTrue(result.contains("\"type\":\"rpc_result\""))
        assertTrue(result.contains("\"id\":\"abc\""))
        assertTrue(result.contains("\"status\":200"))
        assertTrue(result.contains("mcp-session-id"))
        val ping = RelayProtocol.ping(1234)
        assertEquals("""{"type":"ping","t":1234}""", ping)
        val pong = RelayProtocol.parseInbound("""{"type":"pong","t":1234}""") as RelayInbound.Pong
        assertEquals(1234L, pong.t)
        assertTrue(RelayProtocol.parseInbound("""{"type":"revoked"}""") is RelayInbound.Revoked)
    }

    @Test
    fun backoff_doubles_with_mid_jitter_and_caps() {
        val sequence = mutableListOf(RELAY_INITIAL_BACKOFF_MS)
        while (sequence.size < 8) {
            sequence += RelayProtocol.nextBackoffMs(sequence.last(), jitterUnit = 0.5)
        }
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L),
            sequence,
        )
        val low = RelayProtocol.nextBackoffMs(1_000L, 0.0)
        val high = RelayProtocol.nextBackoffMs(1_000L, 1.0)
        assertTrue(low >= RELAY_INITIAL_BACKOFF_MS)
        assertTrue(high <= RELAY_MAX_BACKOFF_MS)
        assertTrue(low <= high)
    }

    @Test
    fun pairing_response_parses_success_and_errors() {
        val ok = RelayPairing.parseResponse(
            200,
            """{"deviceToken":"dbt_abcdefghijklmnopqrstuvwxyz012345","accountId":"acct_1","mcpUrl":"https://droid.synqra.info/mcp"}""",
        ) as RelayPairOutcome.Ok
        assertEquals("dbt_abcdefghijklmnopqrstuvwxyz012345", ok.success.deviceToken)
        assertEquals("acct_1", ok.success.accountId)
        assertEquals("https://droid.synqra.info/mcp", ok.success.mcpUrl)
        val gone = RelayPairing.parseResponse(410, """{"error":"expired"}""") as RelayPairOutcome.Err
        assertEquals(410, gone.status)
        assertEquals("expired", gone.message)
        val missing = RelayPairing.parseResponse(200, """{"deviceToken":"short"}""") as RelayPairOutcome.Err
        assertEquals("invalid_pair_payload", missing.message)
        assertTrue(RelayPairing.isPairCode("AB2D3EFG"))
    }
}
