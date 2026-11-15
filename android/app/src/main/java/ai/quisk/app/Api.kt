package ai.quisk.app

import android.content.Context
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** The quisk.ai account token: the same signed value as the web session cookie. */
object Token {
    private const val PREFS = "quisk"

    fun get(context: Context): String? = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("token", null)

    fun set(context: Context, token: String?) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
            if (token == null) remove("token") else putString("token", token)
        }.apply()
    }
}

class SignedOut : IOException("Open Quisk and sign in first.")

object Api {
    const val BASE = "https://quisk.ai"

    data class Answer(val url: String, val answer: String, val speech: String)

    private fun post(context: Context, path: String, body: JSONObject): HttpURLConnection {
        val token = Token.get(context) ?: throw SignedOut()
        val conn = URL("$BASE/$path").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 10_000
        conn.readTimeout = 30_000
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        return conn
    }

    /** Search and answer in one call (blocking; call off the main thread). The answer is also saved as a chat. */
    fun ask(context: Context, question: String): Answer {
        val conn = post(context, "api/ask", JSONObject().put("q", question))
        val code = conn.responseCode
        // A signed-out request gets the sign-in page (HTML) back.
        if (conn.contentType?.contains("text/html") == true) throw SignedOut()
        val text = (if (code == 200) conn.inputStream else conn.errorStream).bufferedReader().use { it.readText() }
        val json = JSONObject(text)
        if (code != 200) throw IOException(json.optString("error", "Quisk is not answering ($code)."))
        return Answer(json.getString("url"), json.getString("answer"), json.getString("speech"))
    }

    /** The answer read aloud by Gemini TTS (WAV), in the Quisk voice. */
    fun speech(context: Context, text: String): ByteArray {
        val conn = post(context, "api/tts", JSONObject().put("text", text))
        if (conn.responseCode != 200) throw IOException("No audio.")
        return conn.inputStream.use { it.readBytes() }
    }
}
