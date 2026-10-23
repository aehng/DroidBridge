package com.droidbridge.standalone.runtimehost

import java.util.concurrent.atomic.AtomicBoolean

/** Process-wide voice kill flag shared by the listener JNI, the service, and Accessibility. */
internal object VoiceKillSwitch {
    val armed = AtomicBoolean(false)
    @Volatile var tunnelHostname: String? = null
}

/** Append-only receiver for one redacted JSON line per public voice HTTP request. */
internal fun interface AuditSink {
    fun append(jsonLine: String)
}
