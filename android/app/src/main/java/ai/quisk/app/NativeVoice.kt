package ai.quisk.app

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.LongBuffer
import kotlin.concurrent.thread

/**
 * tiny-voca, shipped in the app (assets/tiny-voca.onnx): phoneme ids in, 24 kHz speech out, with ONNX Runtime on
 * the CPU. Loaded in the background at launch, so the first answer does not wait for it.
 */
object NativeVoice {
    private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }
    @Volatile private var session: OrtSession? = null

    fun preload(context: Context) {
        val app = context.applicationContext
        thread(name = "voice-preload") { load(app) }
    }

    @Synchronized
    private fun load(context: Context): OrtSession = session ?: run {
        val bytes = context.assets.open("tiny-voca.onnx").use { it.readBytes() }
        val options = OrtSession.SessionOptions().apply { setIntraOpNumThreads(2) }
        env.createSession(bytes, options).also { session = it }
    }

    private fun longs(values: LongArray, shape: LongArray) = OnnxTensor.createTensor(env, LongBuffer.wrap(values), shape)
    private fun float(value: Float) = OnnxTensor.createTensor(env, FloatBuffer.wrap(floatArrayOf(value)), longArrayOf(1))

    /** {"ph": [{"ids": [...], "stress": [...]}], "voice": 0|1, "speed": 1-2} -> WAV bytes, with a short pause after each sentence. */
    fun speak(context: Context, request: JSONObject): ByteArray {
        val session = load(context)
        val voice = request.optLong("voice", 0)
        val speed = request.optDouble("speed", 1.0).toFloat().coerceIn(0.5f, 3f)
        val pause = (6000 / speed).toInt()
        val pcm = ByteArrayOutputStream()
        val sentences = request.getJSONArray("ph")
        for (i in 0 until sentences.length()) {
            val p = sentences.optJSONObject(i) ?: continue
            val idsJson = p.getJSONArray("ids")
            val stressJson = p.getJSONArray("stress")
            val n = minOf(idsJson.length(), 512)
            if (n == 0) continue
            val ids = LongArray(n) { idsJson.getLong(it) }
            val stress = LongArray(n) { stressJson.getLong(it) }
            val inputs = mapOf(
                "tokens" to longs(ids, longArrayOf(1, n.toLong())),
                "stress" to longs(stress, longArrayOf(1, n.toLong())),
                "voice" to longs(longArrayOf(voice), longArrayOf(1)),
                "speed" to float(speed), "pitch_shift" to float(0f), "pitch_range" to float(1f),
            )
            session.run(inputs, setOf("audio")).use { out ->
                @Suppress("UNCHECKED_CAST")
                val audio = (out.get("audio").get().value as Array<FloatArray>)[0]
                val buf = ByteBuffer.allocate((audio.size + pause) * 2).order(ByteOrder.LITTLE_ENDIAN)
                for (s in audio) buf.putShort((s.coerceIn(-1f, 1f) * 32767).toInt().toShort())
                repeat(pause) { buf.putShort(0) }
                pcm.write(buf.array())
            }
            inputs.values.forEach { it.close() }
        }
        return wav(pcm.toByteArray(), 24000)
    }

    private fun wav(pcm: ByteArray, rate: Int): ByteArray {
        val h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + pcm.size).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
            .putInt(rate).putInt(rate * 2).putShort(2).putShort(16).put("data".toByteArray()).putInt(pcm.size)
        return h.array() + pcm
    }

    /** window.QuiskAndroid.speak(json) -> base64 WAV, for the chat page's read-aloud. */
    class Bridge(private val context: Context, private val onListen: () -> Unit) {
        /** The page's talk button: start speech input. */
        @JavascriptInterface
        fun listen() = onListen()

        @JavascriptInterface
        fun speak(json: String): String? = try {
            Base64.encodeToString(speak(context, JSONObject(json)), Base64.NO_WRAP)
        } catch (e: Exception) {
            null
        }
    }
}
