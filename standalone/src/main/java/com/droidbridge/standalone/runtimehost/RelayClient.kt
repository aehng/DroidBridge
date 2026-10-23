package com.droidbridge.standalone.runtimehost

import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal enum class RelayRunState {
    Unpaired,
    Connecting,
    Connected,
    Offline,
}

internal data class RelaySnapshot(
    val status: RelayRunState = RelayRunState.Unpaired,
    val lastError: String? = null,
    val relayBase: String = RELAY_DEFAULT_BASE,
    val paired: Boolean = false,
    val quickTunnelFallback: Boolean = false,
)

internal class RelayClient(
    private val store: RelayStore,
    private val listenerPort: Int,
    private val pathToken: () -> String?,
    private val network: TunnelNetworkMonitor,
    private val killed: () -> Boolean,
    private val sleeper: (Long) -> Unit = { Thread.sleep(it) },
    private val nowMs: () -> Long = { System.currentTimeMillis() },
    private val jitter: () -> Double = { Math.random() },
    private val connect: (String, String) -> RelayWebSocket = { base, token ->
        RelayWebSocket.connect(base, token)
    },
    private val forward: (Int, String, RelayInbound.Rpc) -> LocalMcpResponse = { port, token, rpc ->
        RelayHttp.postLocalMcp(port, token, rpc.body, rpc.headers)
    },
) {
    private val lock = Any()
    private val _snapshot = MutableStateFlow(RelaySnapshot())
    val snapshot: StateFlow<RelaySnapshot> = _snapshot.asStateFlow()
    private val wanted = AtomicBoolean(false)
    private val networkWatching = AtomicBoolean(false)
    private val workers = Executors.newCachedThreadPool()
    private var worker: Thread? = null
    private var socket: RelayWebSocket? = null
    private var generation = 0L
    private var workerGeneration = -1L
    private var backoffMs = RELAY_INITIAL_BACKOFF_MS

    init {
        val persisted = store.load()
        publishFrom(
            persisted,
            if (persisted.paired) RelayRunState.Offline else RelayRunState.Unpaired,
            null,
        )
    }

    fun settingsJson(): String {
        val snap = _snapshot.value
        return org.json.JSONObject().apply {
            put("schema_version", 1)
            put("status", snap.status.name.lowercase())
            put("paired", snap.paired)
            put("relay_base", snap.relayBase)
            put("mcp_url", relayMcpUrl(snap.relayBase))
            put("quick_tunnel_fallback", snap.quickTunnelFallback)
            snap.lastError?.let { put("last_error", it) }
        }.toString()
    }

    fun pair(code: String, relayBase: String, deviceName: String): String {
        val base = relayBase.trim().ifEmpty { RELAY_DEFAULT_BASE }.trimEnd('/')
        val outcome = RelayHttp.pair(base, code, deviceName)
        return when (outcome) {
            is RelayPairOutcome.Ok -> {
                val persisted = store.save(
                    store.load().copy(relayBase = base, deviceToken = outcome.success.deviceToken),
                )
                if (killed()) {
                    publishFrom(persisted, RelayRunState.Offline, "killed")
                } else {
                    publishFrom(persisted, RelayRunState.Connecting, null)
                    start()
                }
                settingsJson()
            }
            is RelayPairOutcome.Err -> org.json.JSONObject().apply {
                put("schema_version", 1)
                put("error", outcome.message)
                put("status", outcome.status)
            }.toString()
        }
    }

    fun unpair(): String {
        stop()
        val persisted = store.unpair()
        publishFrom(persisted, RelayRunState.Unpaired, null)
        return settingsJson()
    }

    fun setQuickTunnelFallback(enabled: Boolean): String {
        val persisted = store.save(store.load().copy(quickTunnelFallback = enabled))
        publishFrom(persisted, _snapshot.value.status, _snapshot.value.lastError)
        return settingsJson()
    }

    fun start() {
        if (killed()) {
            stop()
            return
        }
        val persisted = store.load()
        if (!persisted.paired) {
            publishFrom(persisted, RelayRunState.Unpaired, null)
            return
        }
        synchronized(lock) {
            // Idempotent: the service calls start() on every onStartCommand/restore.
            // Bumping the generation here used to kill the live socket each time,
            // leaving the relay stuck in Connecting.
            if (wanted.get() && worker?.isAlive == true && workerGeneration == generation) {
                return@synchronized
            }
            wanted.set(true)
            generation += 1
            backoffMs = RELAY_INITIAL_BACKOFF_MS
            publishFrom(persisted, RelayRunState.Connecting, null)
            ensureWorkerLocked()
        }
        watchNetwork()
    }

    fun stop() {
        synchronized(lock) {
            wanted.set(false)
            generation += 1
            socket?.close()
            socket = null
            worker?.interrupt()
            worker = null
            val persisted = store.load()
            val status = if (persisted.paired) RelayRunState.Offline else RelayRunState.Unpaired
            publishFrom(persisted, status, _snapshot.value.lastError)
        }
        network.stop()
        networkWatching.set(false)
    }

    private fun watchNetwork() {
        if (!networkWatching.compareAndSet(false, true)) return
        if (!network.start { available -> if (available) reconnectNow() }) {
            networkWatching.set(false)
        }
    }

    private fun reconnectNow() {
        synchronized(lock) {
            if (!wanted.get()) return
            socket?.close()
            socket = null
            worker?.interrupt()
            ensureWorkerLocked()
        }
    }

    private fun ensureWorkerLocked() {
        if (worker?.isAlive == true && workerGeneration == generation) return
        val expected = generation
        workerGeneration = expected
        worker = Thread({ runLoop(expected) }, "relay-client").also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun runLoop(expectedGeneration: Long) {
        while (wanted.get() && expectedGeneration == generation) {
            if (killed()) {
                stop()
                return
            }
            val persisted = store.load()
            val token = persisted.deviceToken
            if (token.isNullOrEmpty()) {
                publishFrom(persisted, RelayRunState.Unpaired, null)
                return
            }
            publishFrom(persisted, RelayRunState.Connecting, _snapshot.value.lastError)
            val session = try {
                connect(persisted.relayBase, token)
            } catch (error: Exception) {
                publishFrom(persisted, RelayRunState.Offline, error.message ?: "connect_failed")
                if (!sleepBackoff(expectedGeneration)) return
                continue
            }
            synchronized(lock) {
                if (!wanted.get() || expectedGeneration != generation) {
                    session.close()
                    return
                }
                socket = session
                backoffMs = RELAY_INITIAL_BACKOFF_MS
                publishFrom(persisted, RelayRunState.Connected, null)
            }
            try {
                pump(session, expectedGeneration)
            } finally {
                session.close()
                synchronized(lock) { if (socket === session) socket = null }
            }
            if (!wanted.get() || expectedGeneration != generation) return
            publishFrom(store.load(), RelayRunState.Offline, _snapshot.value.lastError ?: "disconnected")
            if (!sleepBackoff(expectedGeneration)) return
        }
    }

    private fun pump(session: RelayWebSocket, expectedGeneration: Long) {
        val ping = Thread({
            while (wanted.get() && expectedGeneration == generation && !killed()) {
                runCatching { session.sendText(RelayProtocol.ping(nowMs())) }
                try {
                    sleeper(RELAY_PING_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    return@Thread
                }
            }
        }, "relay-ping")
        ping.isDaemon = true
        ping.start()
        try {
            while (wanted.get() && expectedGeneration == generation && !killed()) {
                val text = try {
                    session.readText()
                } catch (error: Exception) {
                    publish(_snapshot.value.copy(lastError = error.message ?: "socket"))
                    return
                } ?: return
                val inbound = try {
                    RelayProtocol.parseInbound(text)
                } catch (error: Exception) {
                    publish(_snapshot.value.copy(lastError = error.message ?: "bad_frame"))
                    continue
                }
                when (inbound) {
                    is RelayInbound.Rpc -> workers.execute { handleRpc(session, inbound) }
                    is RelayInbound.Pong -> Unit
                    RelayInbound.Revoked -> {
                        store.unpair()
                        publishFrom(store.load(), RelayRunState.Unpaired, "revoked")
                        wanted.set(false)
                        session.close()
                        return
                    }
                }
            }
        } finally {
            ping.interrupt()
        }
    }

    private fun handleRpc(session: RelayWebSocket, rpc: RelayInbound.Rpc) {
        val token = pathToken()
        val result = if (token.isNullOrEmpty()) {
            LocalMcpResponse(503, null, null)
        } else {
            forward(listenerPort, token, rpc)
        }
        val frame = RelayProtocol.rpcResult(rpc.id, result.status, result.body, result.sessionId)
        runCatching { session.sendText(frame) }
    }

    private fun sleepBackoff(expectedGeneration: Long): Boolean {
        val delay = synchronized(lock) {
            if (!wanted.get() || expectedGeneration != generation) return false
            val current = backoffMs
            backoffMs = RelayProtocol.nextBackoffMs(current, jitter())
            current
        }
        return try {
            sleeper(delay)
            wanted.get() && expectedGeneration == generation
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            wanted.get() && expectedGeneration == generation
        }
    }

    private fun publishFrom(persisted: RelayPersisted, status: RelayRunState, error: String?) {
        publish(
            RelaySnapshot(
                status = status,
                lastError = error,
                relayBase = persisted.relayBase,
                paired = persisted.paired,
                quickTunnelFallback = persisted.quickTunnelFallback,
            ),
        )
    }

    private fun publish(next: RelaySnapshot) {
        _snapshot.value = next
    }
}
