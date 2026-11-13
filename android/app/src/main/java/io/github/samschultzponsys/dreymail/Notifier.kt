// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

package io.github.samschultzponsys.dreymail

import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import androidx.core.app.NotificationCompat
import org.json.JSONArray

/**
 * New-mail notifications. Every mail account has its own Android notification channel, so each
 * can have its own sound, vibration and importance (Android's settings for the app, or
 * DreyMail's Settings → Notifications). The small status-bar icon is tinted in the account's
 * colour and the large icon is the envelope drawn in it.
 */
object Notifier {
    private const val GENERAL = "general"
    private const val GROUP = "accounts"
    fun channelId(accountId: String) = "account_$accountId"

    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

    fun ensureGeneral(context: Context) {
        val m = manager(context)
        m.createNotificationChannelGroup(NotificationChannelGroup(GROUP, "Mail accounts"))
        m.createNotificationChannel(NotificationChannel(GENERAL, "DreyMail", NotificationManager.IMPORTANCE_DEFAULT))
    }

    /** accountsJson: [{ id, name, color }]. Creates/renames channels; removes those of deleted accounts. */
    fun syncChannels(context: Context, accountsJson: String) {
        val m = manager(context)
        ensureGeneral(context)
        val accounts = JSONArray(accountsJson)
        val keep = mutableSetOf(GENERAL)
        for (i in 0 until accounts.length()) {
            val a = accounts.getJSONObject(i)
            val id = channelId(a.getString("id"))
            keep += id
            // Creating an existing channel only updates its name; the user's sound choice stays.
            val channel = NotificationChannel(id, a.optString("name", "Mail"), NotificationManager.IMPORTANCE_HIGH)
            channel.description = "New mail in ${a.optString("name", "this account")}"
            channel.group = GROUP
            channel.enableLights(true)
            channel.lightColor = parseColor(a.optString("color"))
            m.createNotificationChannel(channel)
        }
        for (c in m.notificationChannels) if (c.id !in keep) m.deleteNotificationChannel(c.id)
        Prefs.of(context).edit().putString("accounts", accountsJson).apply()
    }

    fun parseColor(hex: String?): Int = runCatching { Color.parseColor(hex) }.getOrDefault(Color.parseColor("#22d3ee"))

    /** The envelope (DreyMail's icon) in the account colour on night navy. */
    private fun largeIcon(color: Int): Bitmap {
        val size = 192
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.color = Color.parseColor("#141b34")
        c.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), 42f, 42f, p)
        p.color = color
        c.drawRoundRect(RectF(33f, 51f, 159f, 141f), 12f, 12f, p)
        p.color = Color.parseColor("#141b34")
        p.style = Paint.Style.STROKE
        p.strokeWidth = 10f
        p.strokeJoin = Paint.Join.ROUND
        p.strokeCap = Paint.Cap.ROUND
        c.drawPath(Path().apply { moveTo(42f, 60f); lineTo(96f, 99f); lineTo(150f, 60f) }, p)
        return bmp
    }

    fun show(context: Context, d: Map<String, String>) {
        val accountId = d["accountId"].orEmpty()
        val color = parseColor(d["color"])
        val m = manager(context)
        val channel = channelId(accountId).takeIf { accountId.isNotEmpty() && m.getNotificationChannel(it) != null } ?: GENERAL
        val open = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_PATH, d["url"] ?: "/")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val tag = d["tag"] ?: "dreymail"
        val pending = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val body = d["body"].orEmpty()
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(color)
            .setLargeIcon(largeIcon(color))
            .setContentTitle(d["title"] ?: "DreyMail")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSubText(d["accountName"]?.takeIf { it.isNotEmpty() })
            .setGroup("account_$accountId")
            .setCategory(NotificationCompat.CATEGORY_EMAIL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .apply { d["badge"]?.toIntOrNull()?.let { setNumber(it) } }
            .build()
        m.notify(tag, 0, n)
    }

    /** Mail read or moved elsewhere: its notifications go away here too. */
    fun clear(context: Context, tagsJson: String) {
        val tags = runCatching { JSONArray(tagsJson) }.getOrNull() ?: return
        val m = manager(context)
        for (i in 0 until tags.length()) m.cancel(tags.getString(i), 0)
    }
}
