// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

package io.github.samschultzponsys.dreymail

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/** DreyMail in a WebView, plus what a browser can't do: per-account notification channels and sounds. */
class MainActivity : Activity() {
    companion object {
        const val EXTRA_PATH = "path"
        private const val FILE_REQUEST = 41
    }

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    /** Origin of the page now showing; the bridge only answers the DreyMail server's own pages. */
    @Volatile private var currentOrigin: String? = null

    private fun serverOrigin(): String? = Prefs.serverUrl(this)?.let { runCatching { Uri.parse(it).let { u -> "${u.scheme}://${u.authority}" } }.getOrNull() }
    private fun originOf(url: String?): String? = url?.let { runCatching { Uri.parse(it).let { u -> "${u.scheme}://${u.authority}" } }.getOrNull() }
    private fun onServer() = currentOrigin != null && currentOrigin == serverOrigin()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        val root = FrameLayout(this).apply { addView(web, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT) }
        // Edge to edge (Android 15+): keep the page clear of the status and navigation bars.
        root.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION")
            v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(root)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            userAgentString = "$userAgentString DreyMailAndroid/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.addJavascriptInterface(Bridge(), "DreyMailAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                return when {
                    url.startsWith("mailto:") -> { openMailto(url); true }
                    // The app and its sign-in (an OIDC provider and back) load here.
                    url.startsWith("http://") || url.startsWith("https://") -> false
                    else -> { openExternal(url); true }
                }
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                currentOrigin = originOf(url)
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                currentOrigin = originOf(url)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            // Links in mail open as new windows: the server's own (a mailto: compose) load here,
            // everything else goes to the browser.
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val probe = WebView(this@MainActivity)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url.toString()
                        if (originOf(url) == serverOrigin()) web.loadUrl(url) else openExternal(url)
                        v.destroy()
                        return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = probe
                resultMsg.sendToTarget()
                return true
            }

            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return runCatching { startActivityForResult(params.createIntent(), FILE_REQUEST) }.isSuccess.also { if (!it) fileCallback = null }
            }
        }

        // Attachments: downloaded with the login cookie into Downloads.
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            runCatching {
                val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val req = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("cookie", CookieManager.getInstance().getCookie(url))
                    .addRequestHeader("user-agent", userAgent)
                    .setMimeType(mimeType)
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                getSystemService(DownloadManager::class.java).enqueue(req)
            }
        }

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        if (Prefs.serverUrl(this) == null) askForServer() else open(intent)
        Handler(Looper.getMainLooper()).postDelayed({ Updater.check(this, manual = false) }, 8000)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        open(intent)
    }

    /** Opens the server, a notification's message, or a new message for a mailto: link. */
    private fun open(intent: Intent?) {
        val base = Prefs.serverUrl(this) ?: return askForServer()
        val data = intent?.data
        when {
            data?.scheme == "mailto" -> openMailto(data.toString())
            intent?.getStringExtra(EXTRA_PATH) != null -> web.loadUrl(base + intent.getStringExtra(EXTRA_PATH)!!.let { if (it.startsWith("/")) it else "/$it" })
            web.url == null -> web.loadUrl(base)
        }
    }

    private fun openMailto(mailto: String) {
        val base = Prefs.serverUrl(this) ?: return
        web.loadUrl("$base/?mailto=${Uri.encode(mailto)}")
    }

    private fun openExternal(url: String) {
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }

    private fun askForServer() {
        val input = EditText(this).apply {
            hint = "https://mail.example.com"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(Prefs.serverUrl(this@MainActivity) ?: "")
        }
        val box = FrameLayout(this).apply { setPadding(48, 16, 48, 0); addView(input) }
        AlertDialog.Builder(this)
            .setTitle("Your DreyMail server")
            .setMessage("Enter the address of your DreyMail server.")
            .setView(box)
            .setCancelable(Prefs.serverUrl(this) != null)
            .setPositiveButton("Connect") { _, _ ->
                val raw = input.text.toString().trim().trimEnd('/')
                val url = if (raw.startsWith("http://") || raw.startsWith("https://")) raw else "https://$raw"
                val u = Uri.parse(url)
                if (u.host.isNullOrEmpty()) return@setPositiveButton askForServer()
                Prefs.setServerUrl(this, "${u.scheme}://${u.authority}")
                web.loadUrl(Prefs.serverUrl(this)!!)
            }
            .show()
    }

    @Deprecated("Back navigation inside the WebView")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    @Deprecated("File chooser result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_REQUEST) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    /** window.DreyMailAndroid: what the web app may ask of the phone. Only the server's pages may use it. */
    inner class Bridge {
        @JavascriptInterface
        fun info(): String = JSONObject().put("version", BuildConfig.VERSION_NAME).put("installKind", "android").toString()

        @JavascriptInterface
        fun setAccounts(json: String) {
            if (onServer()) runCatching { Notifier.syncChannels(this@MainActivity, json) }
        }

        @JavascriptInterface
        fun registerPush(firebaseJson: String) {
            if (!onServer()) return
            Prefs.setFirebase(this@MainActivity, firebaseJson)
            if (!DreyMailApp.initFirebase(applicationContext)) return
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                val keys = WebPushCrypto.keys(this@MainActivity)
                val detail = JSONObject().put("token", token).put("p256dh", keys.p256dh).put("auth", keys.auth)
                runOnUiThread {
                    web.evaluateJavascript("window.dispatchEvent(new CustomEvent('dreymail-android-token', { detail: $detail }))", null)
                }
            }
        }

        @JavascriptInterface
        fun openChannelSettings(accountId: String) {
            if (!onServer()) return
            val intent = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, Notifier.channelId(accountId))
            runOnUiThread { runCatching { startActivity(intent) } }
        }

        @JavascriptInterface
        fun checkForUpdates() {
            if (onServer()) Updater.check(this@MainActivity, manual = true)
        }

        @JavascriptInterface
        fun changeServer() {
            if (onServer()) runOnUiThread { askForServer() }
        }
    }
}
