package ai.quisk.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.util.Locale
import kotlin.concurrent.thread

/**
 * Ask aloud: Android's speech input takes the question, Quisk answers, and the answer is read in the Quisk voice
 * (Gemini TTS), or the phone's own voice if that fails. Opened by its launcher icon, the side key or Quick Tap
 * ("open app"), the assist gesture when Quisk is the default assistant, or a voice command.
 */
class AskActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var question: TextView
    private lateinit var answer: TextView
    private lateinit var busy: ProgressBar
    private lateinit var action: Button
    private var player: MediaPlayer? = null
    private var tts: TextToSpeech? = null
    private var url: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        actionBar?.hide()
        setContentView(layout())
        if (Token.get(this) == null) {
            answer.text = "Open Quisk and sign in first."
            action.text = "Open Quisk"
            action.setOnClickListener { startActivity(Intent(this, MainActivity::class.java)); finish() }
            return
        }
        listen()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        stopSpeaking()
        listen()
    }

    private fun listen() {
        question.text = ""
        answer.text = ""
        busy.visibility = android.view.View.GONE
        action.text = "Ask again"
        action.setOnClickListener { stopSpeaking(); listen() }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "What do you want to know?")
        try {
            startActivityForResult(intent, LISTEN)
        } catch (e: ActivityNotFoundException) {
            answer.text = "This phone has no speech input. Install the Google app."
        }
    }

    @Deprecated("Speech input result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != LISTEN) return
        val heard = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
        if (resultCode != RESULT_OK || heard.isNullOrEmpty()) {
            answer.text = "I didn't hear a question."
            return
        }
        ask(heard)
    }

    private fun ask(q: String) {
        question.text = q
        busy.visibility = android.view.View.VISIBLE
        thread {
            try {
                val result = Api.ask(this, q)
                main.post {
                    busy.visibility = android.view.View.GONE
                    answer.text = result.answer.replace(Regex("""\s*\[\d+(?:,\s*\d+)*]"""), "").replace(Regex("""!\[[^\]]*]\([^)]*\)"""), "")
                    url = result.url
                    action.text = "Ask again"
                }
                try {
                    val wav = Api.speech(this, result.speech)
                    main.post { play(wav) }
                } catch (e: Exception) {
                    main.post { speakWithPhoneVoice(result.speech) }
                }
            } catch (e: Exception) {
                main.post {
                    busy.visibility = android.view.View.GONE
                    answer.text = e.message ?: "Quisk is not answering. Try again."
                }
            }
        }
    }

    private fun play(wav: ByteArray) {
        val file = File(cacheDir, "answer.wav").apply { writeBytes(wav) }
        player = MediaPlayer().apply {
            setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            setDataSource(file.path)
            setOnCompletionListener { it.release(); player = null }
            prepare()
            start()
        }
    }

    private fun speakWithPhoneVoice(text: String) {
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.getDefault()
                tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "answer")
            }
        }
    }

    private fun stopSpeaking() {
        player?.run { stop(); release() }
        player = null
        tts?.run { stop(); shutdown() }
        tts = null
    }

    override fun onDestroy() {
        stopSpeaking()
        super.onDestroy()
    }

    private fun layout(): LinearLayout {
        val pad = (24 * resources.displayMetrics.density).toInt()
        question = TextView(this).apply { textSize = 18f; setTextColor(Color.GRAY) }
        answer = TextView(this).apply { textSize = 20f; setPadding(0, pad / 2, 0, 0) }
        busy = ProgressBar(this).apply { visibility = android.view.View.GONE }
        action = Button(this)
        val open = Button(this).apply {
            text = "Open chat"
            setOnClickListener {
                stopSpeaking()
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url ?: Api.BASE)).setClass(this@AskActivity, MainActivity::class.java))
                finish()
            }
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad)
            addView(question)
            addView(busy, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = pad })
            addView(ScrollView(context).apply { addView(answer) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(action, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                addView(open, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            })
        }
    }

    private companion object { const val LISTEN = 1 }
}
