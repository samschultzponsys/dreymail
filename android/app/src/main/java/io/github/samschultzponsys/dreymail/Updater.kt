// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

package io.github.samschultzponsys.dreymail

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Checks GitHub for a newer DreyMail release (on every start, and from Settings → General). The
 * APK is installed by downloading it: Android shows its "update app" screen, and settings and
 * login are kept.
 */
object Updater {
    private const val API = "https://api.github.com/repos/samschultzponsys/dreymail/releases/latest"
    private const val PAGE = "https://github.com/samschultzponsys/dreymail/releases/latest"

    private fun parse(v: String): Pair<Int, Int>? =
        Regex("""^v?(\d+)\.(\d+)""").find(v.trim())?.let { it.groupValues[1].toInt() to it.groupValues[2].toInt() }

    fun isNewer(latest: String, current: String): Boolean {
        val a = parse(latest) ?: return false
        val b = parse(current) ?: return false
        return if (a.first != b.first) a.first > b.first else a.second > b.second
    }

    fun check(activity: Activity, manual: Boolean) {
        thread {
            val release = runCatching {
                val conn = URL(API).openConnection() as HttpURLConnection
                conn.setRequestProperty("accept", "application/vnd.github+json")
                conn.connectTimeout = 15_000
                conn.readTimeout = 15_000
                JSONObject(conn.inputStream.bufferedReader().readText())
            }.getOrNull()
            activity.runOnUiThread {
                if (activity.isFinishing) return@runOnUiThread
                val current = BuildConfig.VERSION_NAME
                if (release == null) {
                    if (manual) AlertDialog.Builder(activity).setMessage("Couldn't check for updates. Try again later.").setPositiveButton("OK", null).show()
                    return@runOnUiThread
                }
                val tag = release.optString("tag_name")
                val version = tag.removePrefix("v")
                if (!isNewer(tag, current)) {
                    if (manual) AlertDialog.Builder(activity).setMessage("DreyMail $current is up to date.").setPositiveButton("OK", null).show()
                    return@runOnUiThread
                }
                val assets = release.optJSONArray("assets")
                var apk: String? = null
                for (i in 0 until (assets?.length() ?: 0)) {
                    val a = assets!!.getJSONObject(i)
                    if (a.optString("name") == "DreyMail-$version.apk") apk = a.optString("browser_download_url")
                }
                AlertDialog.Builder(activity)
                    .setTitle("DreyMail $version is available")
                    .setMessage("You have $current. Download DreyMail-$version.apk and open it: Android asks to update DreyMail, and your settings and login stay.")
                    .setPositiveButton("Download") { _, _ -> activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(apk ?: PAGE))) }
                    .setNeutralButton("Release notes") { _, _ -> activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(release.optString("html_url", PAGE)))) }
                    .setNegativeButton("Later", null)
                    .show()
            }
        }
    }
}
