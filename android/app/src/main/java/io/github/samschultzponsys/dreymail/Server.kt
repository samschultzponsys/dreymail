// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

package io.github.samschultzponsys.dreymail

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Calls to the DreyMail server outside the WebView, signed in with the WebView's login cookie. */
object Server {
    fun registerToken(context: Context, token: String) {
        val base = Prefs.serverUrl(context) ?: return
        val keys = WebPushCrypto.keys(context)
        thread {
            runCatching {
                val url = URL("$base/api/push/android")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 15_000
                conn.readTimeout = 15_000
                conn.setRequestProperty("content-type", "application/json")
                conn.setRequestProperty("x-dreymail", "1")
                CookieManager.getInstance().getCookie(base)?.let { conn.setRequestProperty("cookie", it) }
                val body = JSONObject().put("token", token).put("keys", JSONObject().put("p256dh", keys.p256dh).put("auth", keys.auth))
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
                conn.responseCode
                conn.disconnect()
            }
        }
    }
}
