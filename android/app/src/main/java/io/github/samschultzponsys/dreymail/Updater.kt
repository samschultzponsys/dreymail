// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

package io.github.samschultzponsys.dreymail

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.widget.Toast
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Checks GitHub for a newer DreyMail release (on start, when coming back after a while, and from
 * Settings → General). "Update now" downloads the APK inside the app (with a progress notification)
 * and opens Android's install screen; settings and login are kept.
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

    private const val PREF_LAST_CHECK = "update_last_check"
    private const val RECHECK_MS = 6 * 3600 * 1000L
    private var pendingInstall: Long = -1

    /** Quiet check if the last one is a while ago (called when the app comes back to the front). */
    fun checkIfDue(activity: Activity) {
        val last = Prefs.of(activity).getLong(PREF_LAST_CHECK, 0)
        if (System.currentTimeMillis() - last > RECHECK_MS) check(activity, manual = false)
    }

    /** Called from onResume: finishes an install that waited for the "install apps" permission. */
    fun resumePendingInstall(activity: Activity) {
        if (pendingInstall >= 0 && (Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls())) {
            val id = pendingInstall
            pendingInstall = -1
            install(activity, id)
        }
    }

    private fun install(activity: Activity, id: Long) {
        val dm = activity.getSystemService(DownloadManager::class.java)
        val uri = dm.getUriForDownloadedFile(id) ?: return Toast.makeText(activity, "The download failed. Try again.", Toast.LENGTH_LONG).show()
        if (!activity.packageManager.canRequestPackageInstalls()) {
            pendingInstall = id
            Toast.makeText(activity, "Allow DreyMail to install updates, then come back.", Toast.LENGTH_LONG).show()
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            return
        }
        activity.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** Downloads the APK with Android's download manager, then opens the installer. */
    private fun download(activity: Activity, url: String, version: String) {
        val dm = activity.getSystemService(DownloadManager::class.java)
        val name = "DreyMail-$version.apk"
        activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.resolve(name)?.delete()
        val id = dm.enqueue(
            DownloadManager.Request(Uri.parse(url))
                .setTitle("DreyMail $version")
                .setDescription("Downloading the update")
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, name),
        )
        Toast.makeText(activity, "Downloading DreyMail $version…", Toast.LENGTH_SHORT).show()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return
                runCatching { activity.unregisterReceiver(this) }
                install(activity, id)
            }
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            activity.registerReceiver(receiver, filter)
        }
    }

    fun check(activity: Activity, manual: Boolean) {
        Prefs.of(activity).edit().putLong(PREF_LAST_CHECK, System.currentTimeMillis()).apply()
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
                    .setMessage("You have $current. The update downloads in the background, then Android asks you to install it. Your settings and login stay.")
                    .setPositiveButton("Update now") { _, _ ->
                        if (apk != null) download(activity, apk!!, version) else activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PAGE)))
                    }
                    .setNeutralButton("Release notes") { _, _ -> activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(release.optString("html_url", PAGE)))) }
                    .setNegativeButton("Later", null)
                    .show()
            }
        }
    }
}
