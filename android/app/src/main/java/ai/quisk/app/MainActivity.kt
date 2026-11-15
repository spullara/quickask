package ai.quisk.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/** quisk.ai in a web view, signed in with the app's token as the session cookie. */
class MainActivity : Activity() {
    private var web: WebView? = null
    private var splash: LinearLayout? = null
    private var loaded = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        actionBar?.hide()
        NativeVoice.preload(this)
        take(intent)
        show()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (take(intent)) return show()
        val url = page(intent) ?: return
        val w = web ?: return show()
        val question = intent.data?.getQueryParameter("q")
        // Page already open: ask in place, so its voice worker (already warm) makes the phonemes from the start.
        if (question != null && loaded) {
            w.evaluateJavascript("window.quiskAsk ? (quiskAsk(${org.json.JSONObject.quote(question)}), 1) : 0") { if (it != "1") w.loadUrl(url) }
        } else w.loadUrl(url)
    }

    /** A quisk.ai page to open (a chat from the voice action), if the intent has one. */
    private fun page(intent: Intent?): String? = intent?.data?.takeIf { it.scheme == "https" && it.host == "quisk.ai" }?.toString()

    /** quisk://auth?token=… from the browser after signing in. */
    private fun take(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (data.scheme != "quisk" || data.host != "auth") return false
        val token = data.getQueryParameter("token") ?: return false
        Token.set(this, token)
        return true
    }

    private fun show() {
        val token = Token.get(this)
        if (token == null) return setContentView(signIn())
        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setCookie(Api.BASE, "s=$token; Path=/; Secure; Max-Age=31536000") {
            web = WebView(this).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                // Talk mode can play answers without a tap.
                settings.mediaPlaybackRequiresUserGesture = false
                // The page sees "QuiskApp" and preloads the on-device voice in the background.
                settings.userAgentString = settings.userAgentString + " QuiskApp/1.0"
                // The page reads answers with the voice built into the app (no model download in the web view).
                addJavascriptInterface(NativeVoice.Bridge(applicationContext) { runOnUiThread { listen() } }, "QuiskAndroid")
                webViewClient = Client()
                loadUrl(page(intent) ?: Api.BASE)
            }
            // Splash until the first page has loaded.
            splash = brand(false)
            setContentView(FrameLayout(this).apply {
                addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
                addView(splash, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            })
        }
    }

    /** Logo and name; with the tagline on the sign-in screen. */
    private fun brand(tagline: Boolean): LinearLayout {
        val pad = (28 * resources.displayMetrics.density).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(if (tagline) Color.TRANSPARENT else Color.WHITE)
            addView(ImageView(context).apply { setImageResource(R.drawable.logo) }, LinearLayout.LayoutParams(pad * 3, pad * 3))
            addView(TextView(context).apply { text = "Quisk"; textSize = 32f; gravity = Gravity.CENTER; setTextColor(Color.BLACK); setPadding(0, pad / 2, 0, 0) })
            if (tagline) addView(TextView(context).apply { text = "Fast answers from the web."; textSize = 16f; gravity = Gravity.CENTER; setTextColor(Color.GRAY) })
        }
    }

    private fun signIn(): LinearLayout {
        val pad = (28 * resources.displayMetrics.density).toInt()
        return brand(true).apply {
            addView(Button(context).apply {
                text = "Sign in"
                setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("${Api.BASE}/auth/app"))) }
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = pad * 2 })
            addView(TextView(context).apply {
                text = "Signs in in your browser with your quisk.ai passkey. New here? Join the waitlist there."
                textSize = 13f; gravity = Gravity.CENTER; setTextColor(Color.GRAY); setPadding(0, pad / 2, 0, 0)
            })
        }
    }

    private inner class Client : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            loaded = true
            splash?.animate()?.alpha(0f)?.setDuration(250)?.withEndAction { splash?.visibility = android.view.View.GONE }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            // Signing out on the web signs out the app (the web view cannot sign back in with a passkey).
            if (url.host == "quisk.ai" && url.path == "/auth/logout") {
                Token.set(this@MainActivity, null)
                CookieManager.getInstance().removeAllCookies(null)
                setContentView(signIn())
                return true
            }
            // Other sites open in the browser.
            if (url.host != "quisk.ai") {
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }
            return false
        }
    }

    /** The page's talk button: Android speech input, then the question is asked in the page and read aloud. */
    private fun listen() {
        val intent = android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_WEB_SEARCH)
            .putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "What do you want to know?")
        try { startActivityForResult(intent, LISTEN) } catch (e: android.content.ActivityNotFoundException) {}
    }

    @Deprecated("Speech input result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val question = data?.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
        if (requestCode == LISTEN && resultCode == RESULT_OK && !question.isNullOrEmpty()) {
            web?.evaluateJavascript("window.quiskTalk && quiskTalk(${org.json.JSONObject.quote(question)})", null)
        }
    }

    private companion object { const val LISTEN = 7 }

    @Deprecated("Back goes back in the web view first")
    override fun onBackPressed() {
        val w = web
        if (w != null && w.canGoBack()) w.goBack() else super.onBackPressed()
    }
}
