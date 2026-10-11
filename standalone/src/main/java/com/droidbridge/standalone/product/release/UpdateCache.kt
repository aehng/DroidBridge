package com.droidbridge.standalone.product.release

import java.io.File

/**
 * Keeps the downloaded-update cache bounded: unreferenced files older than a day go first, then the
 * oldest unreferenced files until the cache fits in 1 GiB. A file maintenance still refers to stays.
 */
internal fun cleanupUpdateCache(cacheRoot: File, referenced: Set<File>, now: Long) {
    val files = cacheRoot.walkBottomUp().filter { it.isFile }.sortedBy { it.lastModified() }.toList()
    val remaining = files.filterNot { file ->
        (now - file.lastModified() > (24L * 60 * 60 * 1000) && file !in referenced) && file.delete()
    }.toMutableList()
    var total = remaining.sumOf { it.length() }
    remaining.filter { it !in referenced }.forEach { file ->
        if (total <= (1L shl 30)) return@forEach
        val size = file.length()
        if (file.delete()) total -= size
    }
    cacheRoot.walkBottomUp().filter { it.isDirectory && it != cacheRoot }.forEach { it.delete() }
}
