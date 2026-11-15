package ai.quisk.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** "Quisk" in the share sheet: asks "Tell me more about this" about the shared link or text in the app. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        // Shared text often carries a link after a title ("Title https://…"); the link alone is the clearest subject.
        val link = Regex("""https?://\S+""").find(text)?.value
        val subject = link ?: text.take(500)
        val next = Intent(this, MainActivity::class.java)
        if (subject.isNotEmpty()) {
            val page = Uri.parse(Api.BASE).buildUpon().appendQueryParameter("q", "Tell me more about this: $subject").build()
            next.setAction(Intent.ACTION_VIEW).setData(page)
        }
        startActivity(next)
        finish()
    }
}
