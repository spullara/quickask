package ai.quisk.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.speech.RecognizerIntent
import android.widget.Toast

/**
 * Ask aloud: starts dictation at once, then asks the question in the chat page with talk mode on, so the answer
 * streams on screen and is read aloud by the on-device voice. Opened by its launcher icon, the side key or Quick Tap
 * ("open app"), the assist gesture when Quisk is the default assistant, or a voice command.
 */
class AskActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Token.get(this) == null) {
            Toast.makeText(this, "Open Quisk and sign in first.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            return finish()
        }
        val listen = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "What do you want to know?")
        try {
            startActivityForResult(listen, LISTEN)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "This phone has no speech input. Install the Google app.", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    @Deprecated("Speech input result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val question = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
        if (requestCode == LISTEN && resultCode == RESULT_OK && !question.isNullOrEmpty()) {
            val page = Uri.parse(Api.BASE).buildUpon().appendQueryParameter("q", question).appendQueryParameter("talk", "true").build()
            startActivity(Intent(Intent.ACTION_VIEW, page).setClass(this, MainActivity::class.java))
        }
        finish()
    }

    private companion object { const val LISTEN = 1 }
}
