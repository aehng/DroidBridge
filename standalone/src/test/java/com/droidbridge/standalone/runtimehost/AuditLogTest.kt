package com.droidbridge.standalone.runtimehost

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class AuditLogTest {
    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun ring_buffer_caps_at_500_rows_and_drops_oldest() {
        val file = File(tempFolder.root, "voice_audit.jsonl")
        val auditLog = AuditLog(file, maxRows = 500)

        // Write 550 entries
        for (i in 1..550) {
            auditLog.append("""{"seq":$i,"tool":"node_action","outcome":"success","latency_ms":10}""")
        }

        val entries = auditLog.entries()
        assertEquals(500, entries.size)

        // Newest first: the first element must be sequence 550
        assertTrue("First element should be seq 550", entries.first().contains(""""seq":550"""))
        // The last element must be sequence 51 (the oldest kept)
        assertTrue("Last element should be seq 51", entries.last().contains(""""seq":51"""))
        // Sequence 1..50 should be completely dropped
        for (i in 1..50) {
            assertFalse("seq $i should have been dropped", entries.any { it.contains(""""seq":$i,""") })
        }

        // Reopening from disk should also preserve the 500 capped entries
        val reloaded = AuditLog(file, maxRows = 500)
        assertEquals(500, reloaded.entries().size)
        assertTrue(reloaded.entries().first().contains(""""seq":550"""))
        assertTrue(reloaded.entries().last().contains(""""seq":51"""))
    }

    @Test
    fun redaction_and_security_events_are_preserved_without_leaking_secrets() {
        val file = File(tempFolder.root, "voice_audit.jsonl")
        val auditLog = AuditLog(file, maxRows = 500)

        // 1. Password field input audit record: text is redacted by rust layer
        val passwordEvent = """{"time":1789495200000,"name":"node_action_input","arguments":{"target":"pwd","action":"replace_selection","text":"***REDACTED***"},"latency_ms":42,"outcome":"success","foreground_package":"com.example.bank"}"""
        auditLog.append(passwordEvent)

        // 2. Auth failure audit record: must not contain caller bearer secret
        val authFailureEvent = """{"time":1789495201000,"name":"auth","arguments":{},"latency_ms":2,"outcome":"auth_failed","foreground_package":null}"""
        auditLog.append(authFailureEvent)

        val entries = auditLog.entries()
        assertEquals(2, entries.size)

        // Verify passwordEvent preserves redaction text and does not leak raw plaintext
        val loggedPasswordEvent = entries.last()
        assertTrue(loggedPasswordEvent.contains("***REDACTED***"))
        assertFalse(loggedPasswordEvent.contains("mySecretPassword123"))

        // Verify auth failure does not contain secrets
        val loggedAuthEvent = entries.first()
        assertTrue(loggedAuthEvent.contains("auth_failed"))
        assertFalse(loggedAuthEvent.contains("Bearer"))
        assertFalse(loggedAuthEvent.contains("token"))
    }

    @Test
    fun clear_removes_all_entries_in_memory_and_on_disk() {
        val file = File(tempFolder.root, "voice_audit.jsonl")
        val auditLog = AuditLog(file, maxRows = 500)

        auditLog.append("""{"tool":"test","outcome":"success"}""")
        assertEquals(1, auditLog.entries().size)
        assertTrue(file.exists())

        auditLog.clear()
        assertEquals(0, auditLog.entries().size)
        assertFalse("Audit log file should be removed on clear", file.exists())
    }
}