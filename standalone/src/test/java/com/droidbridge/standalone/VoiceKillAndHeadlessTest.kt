package com.droidbridge.standalone

import android.app.Service
import android.content.Intent
import com.droidbridge.standalone.execution.android.AccessibilityKillGate
import com.droidbridge.standalone.execution.android.KillAwareGestureRunner
import com.droidbridge.standalone.execution.android.LatchDispatch
import com.droidbridge.standalone.runtimehost.HeadlessActions
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceKillAndHeadlessTest {
    @Test
    fun kill_before_execute_leaves_gesture_counter_at_zero() {
        val runner = KillAwareGestureRunner(killed = { true })
        runner.execute()
        assertEquals(0, runner.gestureCount.get())
        assertEquals(0, runner.executeCount.get())
    }

    @Test
    fun dispatched_gesture_is_not_claimed_revoked() {
        val latch = CountDownLatch(1)
        val dispatch = LatchDispatch(latch)
        val killed = AtomicBoolean(false)
        dispatch.dispatchThenKill { killed.set(true) }
        assertTrue(latch.await(1, TimeUnit.SECONDS))
        assertTrue(dispatch.dispatched)
        assertFalse(dispatch.claimedRevoked)
        assertFalse(AccessibilityKillGate.claimRevokedAfterDispatch(true))
        assertTrue(killed.get())
    }

    @Test
    fun receiver_action_routing() {
        assertEquals(true to true, HeadlessActions.routes(Intent.ACTION_BOOT_COMPLETED))
        assertEquals(true to false, HeadlessActions.routes(Intent.ACTION_LOCKED_BOOT_COMPLETED))
        assertEquals(true to false, HeadlessActions.routes(Intent.ACTION_USER_UNLOCKED))
        assertEquals(true to true, HeadlessActions.routes(Intent.ACTION_MY_PACKAGE_REPLACED))
        assertEquals(false to true, HeadlessActions.routes(Intent.ACTION_TIME_CHANGED))
        assertEquals(false to false, HeadlessActions.routes("android.intent.action.UNKNOWN"))
    }

    @Test
    fun start_sticky_when_armed() {
        assertEquals(Service.START_STICKY, HeadlessActions.startStickyWhenArmed(armed = true, killed = false))
        assertEquals(Service.START_NOT_STICKY, HeadlessActions.startStickyWhenArmed(armed = true, killed = true))
        assertEquals(Service.START_NOT_STICKY, HeadlessActions.startStickyWhenArmed(armed = false, killed = false))
    }
}
