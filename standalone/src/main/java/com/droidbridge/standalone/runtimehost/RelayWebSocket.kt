package com.droidbridge.standalone.runtimehost

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.SecureRandom
import java.util.Base64
import javax.net.ssl.SSLSocketFactory

internal class RelayWebSocket(
    private val socket: Socket,
    private val input: DataInputStream,
    private val output: OutputStream,
) : AutoCloseable {
    @Volatile private var closed = false

    fun sendText(text: String) {
        sendFrame(opcode = 0x1, payload = text.toByteArray(Charsets.UTF_8))
    }

    fun readText(): String? {
        while (true) {
            val frame = readFrame() ?: return null
            when (frame.opcode) {
                0x1 -> return frame.payload.toString(Charsets.UTF_8)
                0x8 -> {
                    close()
                    return null
                }
                0x9 -> sendFrame(opcode = 0xA, payload = frame.payload)
                0xA -> continue
                else -> continue
            }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        runCatching { sendFrame(opcode = 0x8, payload = ByteArray(0)) }
        runCatching { socket.close() }
    }

    private fun sendFrame(opcode: Int, payload: ByteArray) {
        require(payload.size <= RELAY_MAX_FRAME_BYTES)
        val mask = ByteArray(4).also { SecureRandom().nextBytes(it) }
        val header = ByteArrayOutputStream()
        header.write(0x80 or opcode)
        when {
            payload.size < 126 -> header.write(0x80 or payload.size)
            payload.size <= 0xFFFF -> {
                header.write(0x80 or 126)
                header.write(payload.size shr 8)
                header.write(payload.size and 0xFF)
            }
            else -> {
                header.write(0x80 or 127)
                var remaining = payload.size.toLong()
                for (shift in 56 downTo 0 step 8) {
                    header.write(((remaining shr shift) and 0xFF).toInt())
                }
            }
        }
        header.write(mask)
        val masked = ByteArray(payload.size) { index -> (payload[index].toInt() xor mask[index % 4].toInt()).toByte() }
        synchronized(output) {
            output.write(header.toByteArray())
            output.write(masked)
            output.flush()
        }
    }

    private fun readFrame(): WsFrame? {
        val b1 = input.read()
        if (b1 < 0) return null
        val b2 = input.read()
        if (b2 < 0) return null
        val opcode = b1 and 0x0F
        val masked = b2 and 0x80 != 0
        var length = (b2 and 0x7F).toLong()
        if (length == 126L) {
            length = ((input.readUnsignedByte() shl 8) or input.readUnsignedByte()).toLong()
        } else if (length == 127L) {
            length = 0
            repeat(8) { length = (length shl 8) or input.readUnsignedByte().toLong() }
        }
        if (length > RELAY_MAX_FRAME_BYTES) error("frame_too_large")
        val mask = if (masked) ByteArray(4).also { input.readFully(it) } else null
        val payload = ByteArray(length.toInt())
        input.readFully(payload)
        if (mask != null) {
            for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
        }
        return WsFrame(opcode, payload)
    }

    private data class WsFrame(val opcode: Int, val payload: ByteArray)

    companion object {
        fun connect(httpsBase: String, deviceToken: String): RelayWebSocket {
            val uri = URI(relayWsUrl(httpsBase))
            val host = uri.host
            val port = if (uri.port > 0) uri.port else if (uri.scheme == "wss") 443 else 80
            val path = if (uri.rawPath.isNullOrEmpty()) "/device/ws" else uri.rawPath
            val socket = if (uri.scheme == "wss") {
                SSLSocketFactory.getDefault().createSocket()
            } else {
                Socket()
            }
            socket.soTimeout = 60_000
            socket.connect(InetSocketAddress(host, port), 15_000)
            val key = Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })
            val handshake = buildString {
                append("GET $path HTTP/1.1\r\n")
                append("Host: $host")
                if (port != 443 && port != 80) append(":$port")
                append("\r\n")
                append("Upgrade: websocket\r\n")
                append("Connection: Upgrade\r\n")
                append("Sec-WebSocket-Version: 13\r\n")
                append("Sec-WebSocket-Key: $key\r\n")
                append("Authorization: Bearer $deviceToken\r\n")
                append("\r\n")
            }
            val output = socket.getOutputStream()
            output.write(handshake.toByteArray(Charsets.US_ASCII))
            output.flush()
            val input = DataInputStream(socket.getInputStream())
            val statusLine = readHttpLine(input)
            require(statusLine.contains(" 101 ")) { "ws_handshake_${statusLine.take(32)}" }
            while (true) {
                val line = readHttpLine(input)
                if (line.isEmpty()) break
            }
            return RelayWebSocket(socket, input, output)
        }

        private fun readHttpLine(input: DataInputStream): String {
            val buffer = StringBuilder()
            while (true) {
                val ch = input.read()
                if (ch < 0) break
                if (ch == '\n'.code) break
                if (ch != '\r'.code) buffer.append(ch.toChar())
            }
            return buffer.toString()
        }
    }
}
