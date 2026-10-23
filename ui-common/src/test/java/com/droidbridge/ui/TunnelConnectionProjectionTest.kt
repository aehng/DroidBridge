package com.droidbridge.ui

import com.droidbridge.ui.mcp.tunnelStateLabel
import com.droidbridge.ui.product.mcp.TunnelRuntimeState
import com.droidbridge.ui.product.mcp.TunnelSettingsReplies
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TunnelConnectionProjectionTest {

    @Test
    fun status_projection_covers_connecting_up_failed_and_stopped() {
        // 1. Connecting
        val connectingReply = """{"schema_version":1,"configured":true,"enabled":true,"mode":"quick","state":"connecting","protocol_version":"2026-07-28"}"""
        val connectingSettings = TunnelSettingsReplies.settings(connectingReply)
        assertNotNull(connectingSettings)
        assertEquals(TunnelRuntimeState.Connecting, connectingSettings!!.state)
        assertEquals(R.string.tunnel_state_connecting, tunnelStateLabel(connectingSettings))

        // 2. Up (Running)
        val runningReply = """{"schema_version":1,"configured":true,"enabled":true,"mode":"quick","url":"https://droidbridge-sample.trycloudflare.com","state":"running","protocol_version":"2026-07-28"}"""
        val runningSettings = TunnelSettingsReplies.settings(runningReply)
        assertNotNull(runningSettings)
        assertEquals(TunnelRuntimeState.Running, runningSettings!!.state)
        assertEquals(R.string.tunnel_state_running, tunnelStateLabel(runningSettings))
        assertEquals("https://droidbridge-sample.trycloudflare.com", runningSettings.url)

        // 3. Failed
        val failedReply = """{"schema_version":1,"configured":true,"enabled":true,"mode":"quick","state":"failed","last_error":"process exited with code 1","protocol_version":"2026-07-28"}"""
        val failedSettings = TunnelSettingsReplies.settings(failedReply)
        assertNotNull(failedSettings)
        assertEquals(TunnelRuntimeState.Failed, failedSettings!!.state)
        assertEquals(R.string.task_state_failed, tunnelStateLabel(failedSettings))
        assertEquals("process exited with code 1", failedSettings.lastError)

        // 4. Stopped
        val stoppedReply = """{"schema_version":1,"configured":false,"enabled":false,"mode":"quick","state":"stopped","protocol_version":"2026-07-28"}"""
        val stoppedSettings = TunnelSettingsReplies.settings(stoppedReply)
        assertNotNull(stoppedSettings)
        assertEquals(TunnelRuntimeState.Stopped, stoppedSettings!!.state)
        assertEquals(R.string.mcp_state_off, tunnelStateLabel(stoppedSettings))
    }

    @Test
    fun connector_url_ends_in_mcp_secret() {
        val runningReply = """{"schema_version":1,"configured":true,"enabled":true,"mode":"quick","url":"https://voice-bridge.trycloudflare.com","state":"running","protocol_version":"2026-07-28"}"""
        val settings = TunnelSettingsReplies.settings(runningReply)
        assertNotNull(settings)

        val connector = settings!!.connectorUrl("secret_voice_tok_456")
        assertEquals("https://voice-bridge.trycloudflare.com/mcp/secret_voice_tok_456", connector)
        assertTrue(connector!!.endsWith("/mcp/secret_voice_tok_456"))

        // Handles trailing slash on URL cleanly
        val copyWithSlash = settings.copy(url = "https://voice-bridge.trycloudflare.com/")
        assertEquals("https://voice-bridge.trycloudflare.com/mcp/secret_voice_tok_456", copyWithSlash.connectorUrl("secret_voice_tok_456"))

        // Null or blank secrets produce null connector URL
        assertNull(settings.connectorUrl(null))
        assertNull(settings.connectorUrl(""))
        assertNull(settings.connectorUrl("   "))

        // Null base URL produces null connector URL
        val stoppedSettings = settings.copy(url = null)
        assertNull(stoppedSettings.connectorUrl("secret_voice_tok_456"))
    }

    @Test
    fun openai_key_fields_are_absent_and_secret_bearing_payloads_rejected() {
        // Any secret-bearing response (such as an old OpenAI api_key) must be rejected
        val secretBearing = """{"schema_version":1,"configured":true,"enabled":true,"mode":"quick","state":"running","api_key":"sk-secret-leak","protocol_version":"2026-07-28"}"""
        assertNull(TunnelSettingsReplies.settings(secretBearing))

        val tokenBearing = """{"schema_version":1,"configured":true,"enabled":true,"mode":"quick","state":"running","token":"secret-token","protocol_version":"2026-07-28"}"""
        assertNull(TunnelSettingsReplies.settings(tokenBearing))

        // Normal valid Cloudflare response has no api_key or secret field
        val valid = """{"schema_version":1,"configured":true,"enabled":true,"mode":"quick","url":"https://demo.trycloudflare.com","state":"running","protocol_version":"2026-07-28"}"""
        val settings = TunnelSettingsReplies.settings(valid)
        assertNotNull(settings)
        assertEquals("quick", settings!!.mode)
        assertEquals("https://demo.trycloudflare.com", settings.url)
    }
}