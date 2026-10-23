package com.droidbridge.standalone.runtimehost

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

internal data class RelayPersisted(
    val relayBase: String = RELAY_DEFAULT_BASE,
    val deviceToken: String? = null,
    val quickTunnelFallback: Boolean = false,
) {
    val paired: Boolean get() = !deviceToken.isNullOrEmpty()
}

internal class RelayStore(
    directory: File,
    private val fileSystem: McpSettingsFileSystem,
) {
    private val file = File(directory, FILE_NAME)
    private val lock = Any()
    private var committed: RelayPersisted? = null

    fun load(): RelayPersisted = synchronized(lock) { loadLocked() }

    fun save(next: RelayPersisted): RelayPersisted = synchronized(lock) {
        commit(next)
        next
    }

    fun unpair(): RelayPersisted = synchronized(lock) {
        val current = loadLocked()
        val next = current.copy(deviceToken = null)
        commit(next)
        next
    }

    private fun loadLocked(): RelayPersisted {
        committed?.let { return it }
        if (!file.exists()) {
            val initial = RelayPersisted()
            committed = initial
            return initial
        }
        return runCatching {
            check(fileSystem.isOwnerOnly(file))
            decode(file.readText())
        }.getOrElse { RelayPersisted() }.also { committed = it }
    }

    private fun commit(next: RelayPersisted) {
        val directory = checkNotNull(file.parentFile)
        check(directory.isDirectory || directory.mkdirs())
        val temporary = File(directory, "$FILE_NAME.tmp")
        try {
            FileOutputStream(temporary).use { output ->
                fileSystem.restrictToOwner(temporary)
                output.write(encode(next).encodeToByteArray())
                output.fd.sync()
            }
            Files.move(
                temporary.toPath(),
                file.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            fileSystem.syncDirectory(directory)
            check(fileSystem.isOwnerOnly(file))
            committed = next
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private companion object {
        const val FILE_NAME = "relay.json"
        const val SCHEMA_VERSION = 1

        fun encode(settings: RelayPersisted): String = buildJsonObject {
            put("schema_version", SCHEMA_VERSION)
            put("relayBase", settings.relayBase)
            put("deviceToken", settings.deviceToken.orEmpty())
            put("quickTunnelFallback", settings.quickTunnelFallback)
        }.toString()

        fun decode(text: String): RelayPersisted {
            val value = Json.parseToJsonElement(text).jsonObject
            val base = (value["relayBase"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
                ?: RELAY_DEFAULT_BASE
            val token = (value["deviceToken"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
            val fallback = (value["quickTunnelFallback"] as? JsonPrimitive)?.booleanOrNull == true
            return RelayPersisted(base.trimEnd('/'), token, fallback)
        }
    }
}
