package com.droidbridge.standalone.execution.android

import com.droidbridge.standalone.runtimehost.VoiceKillSwitch
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

/**
 * Kill checks for Accessibility gestures. A gesture whose [dispatchGesture] has already been
 * invoked is not claimed revoked; AccessibilityService has no cancel for that call.
 */
internal object AccessibilityKillGate {
    fun blocked(): Boolean = VoiceKillSwitch.armed.get()

    fun allowExecute(killed: Boolean): Boolean = !killed

    fun allowDispatch(killed: Boolean): Boolean = !killed

    /** The plan cannot revoke a gesture already inside dispatchGesture. */
    fun claimRevokedAfterDispatch(alreadyDispatched: Boolean): Boolean = false && alreadyDispatched
}

/** JVM-testable stand-in for execute/dispatchGesture counters. */
internal class KillAwareGestureRunner(
    private val killed: () -> Boolean,
    private val onDispatch: () -> Unit = {},
) {
    val gestureCount = AtomicInteger(0)
    val executeCount = AtomicInteger(0)

    fun execute() {
        if (!AccessibilityKillGate.allowExecute(killed())) return
        executeCount.incrementAndGet()
        dispatchGesture()
    }

    fun dispatchGesture() {
        if (!AccessibilityKillGate.allowDispatch(killed())) return
        gestureCount.incrementAndGet()
        onDispatch()
    }
}

internal class LatchDispatch(private val latch: CountDownLatch) {
    @Volatile var dispatched = false
    @Volatile var claimedRevoked = false

    fun dispatchThenKill(kill: () -> Unit) {
        dispatched = true
        kill()
        latch.countDown()
        claimedRevoked = AccessibilityKillGate.claimRevokedAfterDispatch(dispatched)
    }
}
