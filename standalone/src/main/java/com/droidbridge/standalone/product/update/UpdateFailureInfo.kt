package com.droidbridge.standalone.product.update

import com.droidbridge.standalone.product.release.ReleaseRejected
import java.io.IOException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * Where an update step failed and why. Stage and code are tokens people quote in reports, so their
 * meaning never changes; [detail] only narrows a code and never carries content from the device.
 */
data class UpdateFailureInfo(val stage: String, val code: String, val detail: String? = null)

/** The release server answered with a status other than success. */
class HttpStatusException(val status: Int) : IOException("release server returned HTTP $status")

internal class UpdateStageException(val stage: String, cause: Throwable) : Exception(cause)

internal inline fun <T> atStage(stage: String, block: () -> T): T =
    try {
        block()
    } catch (error: UpdateStageException) {
        throw error
    } catch (error: Exception) {
        throw UpdateStageException(stage, error)
    }

internal fun failureOf(error: Throwable): UpdateFailureInfo {
    val stage = (error as? UpdateStageException)?.stage ?: "update"
    val cause = (error as? UpdateStageException)?.cause ?: error
    val named = cause.javaClass.simpleName.takeIf { it.isNotEmpty() }
    val (code, detail) = when (cause) {
        is UnknownHostException -> "DNS_FAILED" to null
        is SocketTimeoutException -> "TIMEOUT" to null
        is SSLException -> "TLS_FAILED" to named
        is HttpStatusException -> "HTTP_${cause.status}" to null
        is ReleaseRejected -> "REJECTED" to cause.message?.take(MAX_DETAIL)
        is SocketException -> "CONNECT_FAILED" to named
        is IOException -> "IO_ERROR" to named
        else -> "UNKNOWN" to named
    }
    return UpdateFailureInfo(stage, code, detail)
}

private const val MAX_DETAIL = 120

/** The text a person copies into a report: versions, platform, time and the failure, nothing else. */
object UpdateDiagnostics {
    fun text(
        failure: UpdateFailureInfo,
        appVersion: String,
        appVersionCode: Long,
        androidApi: Int,
        abis: List<String>,
        timeUtc: String,
    ): String = buildString {
        appendLine("DroidBridge update diagnostics")
        appendLine("app: $appVersion ($appVersionCode)")
        appendLine("android_api: $androidApi")
        appendLine("abis: ${abis.joinToString(",")}")
        appendLine("time_utc: $timeUtc")
        appendLine("stage: ${failure.stage}")
        appendLine("code: ${failure.code}")
        failure.detail?.let { appendLine("detail: ${it.replace('\n', ' ')}") }
    }
}
