package com.droidbridge.standalone

import com.droidbridge.standalone.runtimehost.CloudflaredSupervisor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudflaredSupervisorTest {
    @Test
    fun parseTryCloudflareUrl_extracts_host_from_cloudflared_log_lines() {
        assertEquals(
            "https://random-words-here.trycloudflare.com",
            CloudflaredSupervisor.parseTryCloudflareUrl(
                "2026-10-23T00:00:00Z INF |  https://random-words-here.trycloudflare.com",
            ),
        )
        assertEquals(
            "https://abc.trycloudflare.com",
            CloudflaredSupervisor.parseTryCloudflareUrl("+https://abc.trycloudflare.com/"),
        )
        assertNull(CloudflaredSupervisor.parseTryCloudflareUrl("INF Registered tunnel connection"))
        assertNull(CloudflaredSupervisor.parseTryCloudflareUrl("https://example.com"))
    }

    @Test
    fun nextBackoffMs_doubles_from_one_second_and_caps_at_sixty() {
        val sequence = mutableListOf(CloudflaredSupervisor.INITIAL_BACKOFF_MS)
        while (sequence.size < 8) {
            sequence += CloudflaredSupervisor.nextBackoffMs(sequence.last())
        }
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L),
            sequence,
        )
    }
}
