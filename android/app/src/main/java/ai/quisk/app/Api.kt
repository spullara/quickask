package ai.quisk.app

import android.content.Context

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

object Api {
    const val BASE = "https://quisk.ai"
}
