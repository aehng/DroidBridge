package com.droidbridge.standalone

import com.droidbridge.standalone.product.release.ReleaseClassification
import com.droidbridge.standalone.product.release.ReleaseConfig
import com.droidbridge.standalone.product.update.ReleaseTransport
import com.droidbridge.standalone.product.update.HttpStatusException
import com.droidbridge.standalone.product.update.UpdateCheck
import com.droidbridge.standalone.product.update.UpdateDiagnostics
import com.droidbridge.standalone.product.update.UpdateFailureInfo
import com.droidbridge.standalone.product.update.UpdateManager
import com.droidbridge.standalone.product.release.cleanupUpdateCache
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import java.nio.file.Files
import java.util.Base64
import java.util.Properties
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class I12_UpdateManagerTest {
    private val properties = Properties().apply { File("../release-config.properties").inputStream().use(::load) }
    private val fixture = File("../tools/fixtures/release/sample-0.1.0")
    private val config = ReleaseConfig.from(
        properties.getProperty("github_owner"),
        properties.getProperty("github_repo"),
        properties.getProperty("manifest_url"),
        properties.getProperty("apk_signer_sha256"),
        properties.getProperty("release_key_id"),
        Base64.getEncoder().encodeToString(File("../tools/fixtures/release/manifest-test-public-key.der").readBytes()),
    )

    /** Serves the signed fixture manifest and fixed artifact bytes; records every requested URL. */
    private class FakeTransport(private val artifacts: Map<String, ByteArray>, manifestDir: File) : ReleaseTransport {
        val requests = mutableListOf<String>()
        private val manifest = File(manifestDir, "release.json").readBytes()
        private val signature = File(manifestDir, "release.json.sig").readBytes()

        override fun <T> get(url: String, maxBytes: Long, read: (InputStream) -> T): T {
            requests += url
            val bytes = when {
                url.endsWith("release.json") -> manifest
                url.endsWith("release.json.sig") -> signature
                else -> artifacts[url.substringAfterLast('/')] ?: error("unexpected $url")
            }
            return read(ByteArrayInputStream(bytes))
        }
    }

    @Test
    fun I12_G01_unconfiguredBuildsNeverTouchTheNetwork() = runBlocking {
        val transport = FakeTransport(emptyMap(), fixture)
        val cache = Files.createTempDirectory("updates").toFile()
        val manager = UpdateManager(ReleaseConfig.Unconfigured, 999, cache, transport)
        manager.check()
        assertEquals(UpdateCheck.Unconfigured, manager.state.value.check)
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun I12_G01_checkClassifiesAndHashMismatchedDownloadsNeverBecomeVerified() = runBlocking {
        val cache = Files.createTempDirectory("updates").toFile()
        val wrongApk = ByteArray(32) { 7 }
        val manager = UpdateManager(config, 999, cache, FakeTransport(mapOf("droidbridge-0.1.0-arm64-v8a.apk" to wrongApk), fixture))
        manager.check()
        val checked = manager.state.value.check as UpdateCheck.Checked
        assertTrue(checked.classification is ReleaseClassification.ProductUpdate)
        assertTrue(manager.state.value.newerVersionAvailable)

        manager.download()
        assertTrue(manager.state.value.downloadFailed)
        assertEquals("verify_apk", manager.state.value.downloadFailure?.stage)
        assertEquals("REJECTED", manager.state.value.downloadFailure?.code)
        assertNull(manager.state.value.downloads)
        assertFalse(File(cache, "0.1.0/droidbridge-0.1.0-arm64-v8a.apk").exists())
        assertFalse(File(cache, "0.1.0/.droidbridge-0.1.0-arm64-v8a.apk.part").exists())
    }

    @Test
    fun I12_G01_theInstalledReleaseIsUpToDateAndDownloadsNothing() = runBlocking {
        val cache = Files.createTempDirectory("updates").toFile()
        val transport = FakeTransport(emptyMap(), fixture)
        val manager = UpdateManager(config, 1000, cache, transport)
        manager.check()
        assertSame(ReleaseClassification.UpToDate, (manager.state.value.check as UpdateCheck.Checked).classification)
        assertFalse(manager.state.value.newerVersionAvailable)
        manager.download()
        assertEquals(listOf("release.json", "release.json.sig"), transport.requests.map { it.substringAfterLast('/') })
        assertNull(manager.state.value.downloads)
    }


    /** Serves the fixture, but fails the request whose URL ends with [failing]. */
    private class FailingTransport(private val failing: String, private val error: () -> Exception, manifestDir: File) : ReleaseTransport {
        private val manifest = File(manifestDir, "release.json").readBytes()
        private val signature = File(manifestDir, "release.json.sig").readBytes()

        override fun <T> get(url: String, maxBytes: Long, read: (InputStream) -> T): T {
            if (url.endsWith(failing)) throw error()
            return read(ByteArrayInputStream(if (url.endsWith("release.json.sig")) signature else manifest))
        }
    }

    private fun failedCheck(failing: String, error: () -> Exception): UpdateFailureInfo = runBlocking {
        val manager = UpdateManager(config, 999, Files.createTempDirectory("updates").toFile(), FailingTransport(failing, error, fixture))
        manager.check()
        (manager.state.value.check as UpdateCheck.Failed).failure
    }

    @Test
    fun I12_G02_aFailedCheckNamesItsStageAndAStableCode() {
        assertEquals(UpdateFailureInfo("fetch_manifest", "DNS_FAILED"), failedCheck("release.json") { UnknownHostException("github.com") })
        assertEquals(UpdateFailureInfo("fetch_manifest", "TIMEOUT"), failedCheck("release.json") { SocketTimeoutException("read timed out") })
        assertEquals(UpdateFailureInfo("fetch_signature", "HTTP_503"), failedCheck("release.json.sig") { HttpStatusException(503) })
        assertEquals(
            UpdateFailureInfo("fetch_manifest", "CONNECT_FAILED", "ConnectException"),
            failedCheck("release.json") { ConnectException("refused") },
        )
        assertEquals(
            UpdateFailureInfo("fetch_signature", "TLS_FAILED", "SSLHandshakeException"),
            failedCheck("release.json.sig") { SSLHandshakeException("no trust anchor") },
        )
    }

    @Test
    fun I12_G02_aSignatureThatDoesNotVerifyIsRejectedAtTheVerifyStage() = runBlocking {
        val tampered = Files.createTempDirectory("tampered").toFile()
        File(fixture, "release.json").copyTo(File(tampered, "release.json"))
        File(tampered, "release.json.sig").writeBytes(File(fixture, "release.json.sig").readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() })
        val manager = UpdateManager(config, 999, Files.createTempDirectory("updates").toFile(), FakeTransport(emptyMap(), tampered))
        manager.check()
        val failure = (manager.state.value.check as UpdateCheck.Failed).failure
        assertEquals("verify_manifest", failure.stage)
        assertEquals("REJECTED", failure.code)
    }

    @Test
    fun I12_G02_aDownloadThatCannotBeFetchedNamesTheDownloadStage() = runBlocking {
        val cache = Files.createTempDirectory("updates").toFile()
        val manager = UpdateManager(config, 999, cache, FailingTransport("arm64-v8a.apk", { SocketTimeoutException("slow") }, fixture))
        manager.check()
        manager.download()
        assertEquals(UpdateFailureInfo("download_apk", "TIMEOUT"), manager.state.value.downloadFailure)
        assertFalse(File(cache, "0.1.0/.droidbridge-0.1.0-arm64-v8a.apk.part").exists() && manager.state.value.downloads != null)
    }

    @Test
    fun I12_G02_theDiagnosticTextCarriesVersionsPlatformTimeAndTheFailureOnly() {
        val text = UpdateDiagnostics.text(
            UpdateFailureInfo("fetch_manifest", "TIMEOUT", "line one\nline two"),
            "0.5.7", 5007, 33, listOf("x86_64", "arm64-v8a"), "2026-10-20T14:17:00Z",
        )
        val expected = listOf(
            "DroidBridge update diagnostics",
            "app: 0.5.7 (5007)",
            "android_api: 33",
            "abis: x86_64,arm64-v8a",
            "time_utc: 2026-10-20T14:17:00Z",
            "stage: fetch_manifest",
            "code: TIMEOUT",
            "detail: line one line two",
        )
        assertEquals(expected, text.lines().filter { it.isNotEmpty() })
    }

    @Test
    fun I12_G01_cleanupRemovesStaleAndPartialFilesButKeepsReferencedArtifacts() {
        val cache = Files.createTempDirectory("updates").toFile()
        val now = 10L * 24 * 60 * 60 * 1000
        val old = File(cache, "0.1.0/old.apk").apply { parentFile?.mkdirs(); writeText("old"); setLastModified(now - 25L * 60 * 60 * 1000) }
        val part = File(cache, "0.1.0/.x.part").apply { writeText("part"); setLastModified(now - 25L * 60 * 60 * 1000) }
        val referenced = File(cache, "0.1.0/keep.zip").apply { writeText("keep"); setLastModified(now - 48L * 60 * 60 * 1000) }
        val fresh = File(cache, "0.1.0/fresh.apk").apply { writeText("fresh"); setLastModified(now - 60_000) }
        cleanupUpdateCache(cache, setOf(referenced), now)
        assertFalse(old.exists())
        assertFalse(part.exists())
        assertTrue(referenced.exists())
        assertTrue(fresh.exists())
    }
}
