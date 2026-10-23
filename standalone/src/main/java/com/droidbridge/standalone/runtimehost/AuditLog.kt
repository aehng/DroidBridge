package com.droidbridge.standalone.runtimehost

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.util.ArrayDeque

/**
 * Persists an append-only JSONL audit log capped at 500 rows in a ring buffer,
 * stored owner-only in the app files directory (P1-09).
 */
internal class AuditLog(
    private val file: File,
    private val maxRows: Int = MAX_ROWS,
) : AuditSink {
    private val lock = Any()
    private val buffer = ArrayDeque<String>(maxRows)
    private var writesSinceCompaction = 0

    constructor(context: Context, fileName: String = FILE_NAME, maxRows: Int = MAX_ROWS) : this(
        File(context.filesDir, fileName),
        maxRows,
    )

    init {
        synchronized(lock) {
            loadExisting()
        }
    }

    private fun loadExisting() {
        if (!file.exists()) return
        runCatching {
            val lines = file.readLines().filter { it.isNotBlank() }
            val start = if (lines.size > maxRows) lines.size - maxRows else 0
            for (i in start until lines.size) {
                buffer.addLast(lines[i])
            }
            if (lines.size > maxRows) {
                compactLocked()
            }
        }
    }

    override fun append(jsonLine: String) {
        val trimmed = jsonLine.trim()
        if (trimmed.isEmpty()) return
        synchronized(lock) {
            if (buffer.size >= maxRows) {
                buffer.removeFirst()
            }
            buffer.addLast(trimmed)
            appendToFileLocked(trimmed)
        }
    }

    /** Returns recent rows newest first. */
    fun entries(): List<String> = synchronized(lock) {
        buffer.toList().asReversed()
    }

    /** Clears all audit entries in memory and on disk. */
    fun clear() = synchronized(lock) {
        buffer.clear()
        writesSinceCompaction = 0
        runCatching {
            if (file.exists()) {
                file.delete()
            }
        }
    }

    private fun appendToFileLocked(line: String) {
        runCatching {
            val isNew = !file.exists()
            val parent = file.parentFile
            if (parent != null && !parent.exists()) {
                parent.mkdirs()
            }
            FileOutputStream(file, true).bufferedWriter().use { writer ->
                writer.write(line)
                writer.newLine()
            }
            if (isNew) {
                restrictToOwner(file)
            }
            writesSinceCompaction++
            if (writesSinceCompaction >= maxRows) {
                compactLocked()
            }
        }
    }

    private fun compactLocked() {
        runCatching {
            val parent = file.parentFile
            if (parent != null && !parent.exists()) {
                parent.mkdirs()
            }
            val temp = File(parent ?: file.absoluteFile.parentFile, "${file.name}.tmp")
            FileOutputStream(temp, false).bufferedWriter().use { writer ->
                for (line in buffer) {
                    writer.write(line)
                    writer.newLine()
                }
            }
            restrictToOwner(temp)
            if (temp.renameTo(file)) {
                restrictToOwner(file)
                writesSinceCompaction = 0
            } else {
                temp.copyTo(file, overwrite = true)
                temp.delete()
                restrictToOwner(file)
                writesSinceCompaction = 0
            }
        }
    }

    private fun restrictToOwner(target: File) {
        target.setReadable(false, false)
        target.setReadable(true, true)
        target.setWritable(false, false)
        target.setWritable(true, true)
        target.setExecutable(false, false)
    }

    companion object {
        const val MAX_ROWS = 500
        const val FILE_NAME = "voice_audit.jsonl"
    }
}