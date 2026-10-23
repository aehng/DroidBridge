package com.droidbridge.standalone.runtimehost

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal enum class CloudflaredMode {
    Quick,
    Named,
}

internal enum class CloudflaredRunState {
    Stopped,
    Connecting,
    Running,
    Failed,
}

internal data class CloudflaredSnapshot(
    val url: String? = null,
    val mode: CloudflaredMode = CloudflaredMode.Quick,
    val state: CloudflaredRunState = CloudflaredRunState.Stopped,
    val lastError: String? = null,
)

internal class CloudflaredSupervisor(
    private val binary: File,
    private val listenerPort: Int,
    private val network: TunnelNetworkMonitor,
    private val processFactory: (List<String>) -> Process = defaultProcessFactory,
    private val sleeper: (Long) -> Unit = { ms -> Thread.sleep(ms) },
    private val cipher: TunnelCredentialCipher? = null,
    private val tokenDirectory: File? = null,
    var onQuickUrlChanged: (String) -> Unit = {},
) {
    private val lock = Any()
    private val _snapshot = MutableStateFlow(CloudflaredSnapshot())
    val snapshot: StateFlow<CloudflaredSnapshot> = _snapshot.asStateFlow()

    private var wanted = false
    private var mode = CloudflaredMode.Quick
    private var namedToken: String? = null
    private var worker: Thread? = null
    private var child: Process? = null
    private var backoffMs = INITIAL_BACKOFF_MS
    private var lastQuickUrl: String? = null
    private var generation = 0L
    private val networkWatching = AtomicBoolean(false)

    fun startQuick() {
        synchronized(lock) {
            mode = CloudflaredMode.Quick
            namedToken = null
            wanted = true
            generation += 1
            backoffMs = INITIAL_BACKOFF_MS
            publish(
                CloudflaredSnapshot(
                    url = lastQuickUrl,
                    mode = CloudflaredMode.Quick,
                    state = CloudflaredRunState.Connecting,
                    lastError = null,
                ),
            )
            ensureWorkerLocked()
        }
        watchNetwork()
    }

    fun startNamed(token: String) {
        val stored = runCatching {
            cipher?.let { c ->
                val encrypted = c.encrypt(NAMED_TOKEN_AAD, token)
                tokenDirectory?.let { dir ->
                    dir.mkdirs()
                    File(dir, TOKEN_FILE).writeText(
                        """{"ciphertext":"${encrypted.ciphertext}","iv":"${encrypted.iv}"}""",
                    )
                }
            }
            token
        }.getOrDefault(token)
        synchronized(lock) {
            mode = CloudflaredMode.Named
            namedToken = stored
            wanted = true
            generation += 1
            backoffMs = INITIAL_BACKOFF_MS
            publish(
                CloudflaredSnapshot(
                    url = null,
                    mode = CloudflaredMode.Named,
                    state = CloudflaredRunState.Connecting,
                    lastError = null,
                ),
            )
            ensureWorkerLocked()
        }
        watchNetwork()
    }

    fun stop() {
        synchronized(lock) {
            wanted = false
            generation += 1
            child?.destroy()
            child = null
            worker?.interrupt()
            worker = null
            publish(
                _snapshot.value.copy(
                    state = CloudflaredRunState.Stopped,
                    lastError = null,
                ),
            )
        }
        network.stop()
        networkWatching.set(false)
    }

    private fun watchNetwork() {
        if (!networkWatching.compareAndSet(false, true)) return
        if (!network.start { available -> onNetworkChanged(available) }) {
            networkWatching.set(false)
            publish(_snapshot.value.copy(lastError = "network_monitor_failed"))
        }
    }

    private fun onNetworkChanged(available: Boolean) {
        if (!available) return
        synchronized(lock) {
            if (!wanted) return
            val proc = child
            if (proc == null || !proc.isAlive) {
                worker?.interrupt()
                ensureWorkerLocked()
            }
        }
    }

    private fun ensureWorkerLocked() {
        if (worker?.isAlive == true) return
        val expected = generation
        worker = Thread({ runLoop(expected) }, "cloudflared-supervisor").also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun runLoop(expectedGeneration: Long) {
        while (true) {
            val command = synchronized(lock) {
                if (!wanted || expectedGeneration != generation) return
                commandLineLocked()
            } ?: run {
                publish(
                    _snapshot.value.copy(
                        state = CloudflaredRunState.Failed,
                        lastError = "binary_missing",
                    ),
                )
                return
            }
            val process = runCatching { processFactory(command) }.getOrElse { error ->
                publish(
                    _snapshot.value.copy(
                        state = CloudflaredRunState.Failed,
                        lastError = "spawn_failed",
                    ),
                )
                if (!sleepBackoff(expectedGeneration)) return
                continue
            }
            synchronized(lock) {
                if (!wanted || expectedGeneration != generation) {
                    process.destroy()
                    return
                }
                child = process
                publish(
                    _snapshot.value.copy(
                        state = CloudflaredRunState.Connecting,
                        lastError = null,
                    ),
                )
            }
            drainOutput(process, expectedGeneration)
            val stillWanted = synchronized(lock) {
                child = null
                wanted && expectedGeneration == generation
            }
            if (!stillWanted) return
            publish(
                _snapshot.value.copy(
                    state = CloudflaredRunState.Failed,
                    lastError = "exited",
                ),
            )
            if (!sleepBackoff(expectedGeneration)) return
        }
    }

    private fun commandLineLocked(): List<String>? {
        if (!binary.isFile) return null
        val path = binary.absolutePath
        val origin = "http://127.0.0.1:$listenerPort"
        return when (mode) {
            CloudflaredMode.Quick -> listOf(
                path,
                "--no-autoupdate",
                "--protocol",
                "http2",
                "tunnel",
                "--url",
                origin,
            )
            CloudflaredMode.Named -> {
                val token = namedToken ?: return null
                listOf(
                    path,
                    "tunnel",
                    "--no-autoupdate",
                    "run",
                    "--token",
                    token,
                )
            }
        }
    }

    private fun drainOutput(process: Process, expectedGeneration: Long) {
        BufferedReader(InputStreamReader(process.inputStream)).use { reader ->
            while (true) {
                val line = try {
                    reader.readLine() ?: break
                } catch (_: Exception) {
                    break
                }
                val url = parseTryCloudflareUrl(line) ?: continue
                val changed = synchronized(lock) {
                    if (!wanted || expectedGeneration != generation) return
                    val previous = lastQuickUrl
                    lastQuickUrl = url
                    backoffMs = INITIAL_BACKOFF_MS
                    publish(
                        CloudflaredSnapshot(
                            url = url,
                            mode = mode,
                            state = CloudflaredRunState.Running,
                            lastError = null,
                        ),
                    )
                    mode == CloudflaredMode.Quick && previous != null && previous != url
                }
                if (changed) onQuickUrlChanged(url)
            }
        }
        runCatching { process.waitFor() }
    }

    private fun sleepBackoff(expectedGeneration: Long): Boolean {
        val delay = synchronized(lock) {
            if (!wanted || expectedGeneration != generation) return false
            val current = backoffMs
            backoffMs = nextBackoffMs(current)
            current
        }
        return try {
            sleeper(delay)
            synchronized(lock) { wanted && expectedGeneration == generation }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            synchronized(lock) { wanted && expectedGeneration == generation }
        }
    }

    private fun publish(next: CloudflaredSnapshot) {
        _snapshot.value = next
    }

    companion object {
        const val INITIAL_BACKOFF_MS = 1_000L
        const val MAX_BACKOFF_MS = 60_000L
        private const val NAMED_TOKEN_AAD = "cloudflare_named_token"
        private const val TOKEN_FILE = "cloudflared-token.json"
        private val TRYCLOUDFLARE =
            Regex("""https://[A-Za-z0-9][A-Za-z0-9.-]*\.trycloudflare\.com/?""")

        fun parseTryCloudflareUrl(line: String): String? =
            TRYCLOUDFLARE.find(line)?.value?.trimEnd('/')

        fun nextBackoffMs(currentMs: Long): Long {
            val base = if (currentMs < INITIAL_BACKOFF_MS) INITIAL_BACKOFF_MS else currentMs
            val doubled = base.saturatingMultiply(2)
            return minOf(MAX_BACKOFF_MS, doubled)
        }

        private fun Long.saturatingMultiply(factor: Long): Long {
            val product = this * factor
            return if (this != 0L && product / this != factor) Long.MAX_VALUE else product
        }

        private val defaultProcessFactory: (List<String>) -> Process = { args ->
            ProcessBuilder(args).redirectErrorStream(true).start()
        }
    }
}
