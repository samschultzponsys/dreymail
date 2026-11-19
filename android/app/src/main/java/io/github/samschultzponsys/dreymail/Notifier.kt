// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-19: notifications as conversations, with the mailbox's icon on the left.
// Modified by samschultzponsys, 2026-11-19: which icon on each side: the mailbox's, its group's or its color (11.5).

package io.github.samschultzponsys.dreymail

import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Matrix
import android.graphics.Path
import android.graphics.RectF
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.PathParser
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray

/**
 * New-mail notifications. Every mail account has its own Android notification channel, so each
 * can have its own sound, vibration and importance (Android's settings for the app, or
 * DreyMail's Settings → Notifications). The small status-bar icon is tinted in the account's
 * colour and the large icon is the envelope drawn in it. A mailbox with its own icon (picked in
 * DreyMail's Accounts) shows that icon in both places instead.
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

    /** accountsJson: [{ id, name, color, icon, image }] (icon: a 24x24 SVG path, or ''; image: the uploaded picture as a data: URL, or ''). Creates/renames channels; removes those of deleted accounts. */
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

    /** What the web app sent about this account: [{ id, name, color, icon, image, groupIcon, groupImage, groupColor }]. */
    private fun account(context: Context, accountId: String): org.json.JSONObject? {
        val json = Prefs.of(context).getString("accounts", null) ?: return null
        val accounts = runCatching { JSONArray(json) }.getOrNull() ?: return null
        for (i in 0 until accounts.length()) {
            val a = accounts.getJSONObject(i)
            if (a.optString("id") == accountId) return a
        }
        return null
    }

    /** An icon's path (24x24 units, as the web app draws it). */
    private fun pathOf(d: String?): Path? {
        if (d.isNullOrEmpty() || d.length > 4000) return null
        return runCatching { PathParser.createPathFromPathData(d) }.getOrNull()
    }

    /** An uploaded picture sent as a data: URL. */
    private fun pictureOf(data: String?): Bitmap? {
        if (data == null) return null
        val comma = data.indexOf(',')
        if (!data.startsWith("data:image/") || comma < 0) return null
        return runCatching {
            val bytes = android.util.Base64.decode(data.substring(comma + 1), android.util.Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { Bitmap.createScaledBitmap(it, 192, 192, true) }
        }.getOrNull()
    }

    /** What a notification shows on one side: a picture, an icon on a tile in `color`, or (neither) the envelope in `color`. */
    private class Look(val pic: Bitmap?, val path: Path?, val color: Int)

    /**
     * The look for a choice (DreyMail 11.5): "mailbox" (its picture or icon, else its color),
     * "group" (the group's picture or icon, else the mailbox's, else its color) or "color".
     */
    private fun look(a: org.json.JSONObject?, kind: String, color: Int): Look {
        if (a == null || kind == "color") return Look(null, null, color)
        val mailbox = pictureOf(a.optString("image"))?.let { Look(it, null, color) } ?: pathOf(a.optString("icon"))?.let { Look(null, it, color) }
        if (kind == "group") {
            val gColor = a.optString("groupColor").takeIf { it.isNotEmpty() }?.let { parseColor(it) } ?: color
            val group = pictureOf(a.optString("groupImage"))?.let { Look(it, null, gColor) } ?: pathOf(a.optString("groupIcon"))?.let { Look(null, it, gColor) }
            return group ?: mailbox ?: Look(null, null, color)
        }
        return mailbox ?: Look(null, null, color)
    }

    private fun largeIcon(l: Look): Bitmap = l.pic ?: l.path?.let { largeIcon(l.color, it) } ?: largeIcon(l.color)

    private fun luminance(color: Int): Double {
        fun ch(v: Int): Double { val c = v / 255.0; return if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * ch(Color.red(color)) + 0.7152 * ch(Color.green(color)) + 0.0722 * ch(Color.blue(color))
    }

    /** Navy or white, whichever reads better on the colour (as in the web app). */
    private fun labelOn(color: Int): Int {
        val l = luminance(color)
        val onNavy = (l + 0.05) / (0.0118 + 0.05)
        val onWhite = 1.05 / (l + 0.05)
        return if (onNavy >= onWhite) Color.parseColor("#141b34") else Color.WHITE
    }

    /** The icon path stroked like the web app draws it: 2 units wide, round ends, 58% of the size. */
    private fun strokeIcon(c: Canvas, size: Int, path: Path, color: Int, fraction: Float) {
        val scale = size * fraction / 24f
        val m = Matrix().apply { setScale(scale, scale); postTranslate((size - 24f * scale) / 2f, (size - 24f * scale) / 2f) }
        val scaled = Path(path).apply { transform(m) }
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 2f * scale
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
            this.color = color
        }
        c.drawPath(scaled, p)
    }

    /** Large icon for a mailbox with its own icon: the icon on a tile in the mailbox colour. */
    private fun largeIcon(color: Int, path: Path): Bitmap {
        val size = 192
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), 42f, 42f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color })
        strokeIcon(c, size, path, labelOn(color), 0.58f)
        return bmp
    }

    /** Status-bar icon: only its shape counts (Android tints it), so white on transparent. */
    private fun smallIcon(path: Path): IconCompat {
        val size = 96
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        strokeIcon(Canvas(bmp), size, path, Color.WHITE, 0.8f)
        return IconCompat.createWithBitmap(bmp)
    }

    fun show(context: Context, d: Map<String, String>) {
        val accountId = d["accountId"].orEmpty()
        val color = parseColor(d["color"])
        val acc = if (accountId.isNotEmpty()) account(context, accountId) else null
        // Which icon on each side (Settings → This device).
        val left = Prefs.leftIcon(context)
        val right = Prefs.rightIcon(context)
        val rightLook = look(acc, if (right == "none") "mailbox" else right, color)
        val leftLook = look(acc, left, color)
        // The status-bar icon: the shape of the icon shown, else DreyMail's envelope.
        val icon = rightLook.path ?: leftLook.path ?: look(acc, "mailbox", color).path
        val m = manager(context)
        val channel = channelId(accountId).takeIf { accountId.isNotEmpty() && m.getNotificationChannel(it) != null } ?: GENERAL
        val open = Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_PATH, d["url"] ?: "/")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val tag = d["tag"] ?: "dreymail"
        val pending = PendingIntent.getActivity(context, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val body = d["body"].orEmpty()
        // As a conversation (the setting): the mailbox's icon on the left, in Android's Conversations section.
        val conversation = if (left != "app" && accountId.isNotEmpty()) runCatching { mailboxShortcut(context, accountId, d["accountName"].orEmpty(), leftLook, open) }.getOrNull() else null
        val n = NotificationCompat.Builder(context, channel)
            .apply { if (icon != null) setSmallIcon(smallIcon(icon)) else setSmallIcon(R.drawable.ic_notification) }
            .setColor(color)
            .apply { if (right != "none") setLargeIcon(largeIcon(rightLook)) }
            .setContentTitle(d["title"] ?: "DreyMail")
            .setContentText(body)
            .apply {
                if (conversation != null) {
                    val sender = Person.Builder().setName(d["title"]?.takeIf { it.isNotEmpty() } ?: "DreyMail").setKey("sender:${d["title"]}").build()
                    val me = Person.Builder().setName(d["accountName"]?.takeIf { it.isNotEmpty() } ?: "Me").setKey("me").build()
                    setShortcutId(conversation)
                    setStyle(NotificationCompat.MessagingStyle(me).setGroupConversation(false).addMessage(body.ifEmpty { " " }, System.currentTimeMillis(), sender))
                } else setStyle(NotificationCompat.BigTextStyle().bigText(body))
            }
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

    private fun shortcutId(accountId: String) = "mailbox_$accountId"

    /**
     * A long-lived shortcut for the mailbox (what Android needs to show a notification as a
     * conversation); its icon is the one on the left of the notification. Returns its id.
     */
    private fun mailboxShortcut(context: Context, accountId: String, name: String, look: Look, open: Intent): String {
        val id = shortcutId(accountId)
        val label = name.ifEmpty { "Mail" }
        val avatar = IconCompat.createWithAdaptiveBitmap(avatar(look.color, look.path, look.pic))
        val intent = Intent(open).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_PATH, "/")
        val shortcut = ShortcutInfoCompat.Builder(context, id)
            .setShortLabel(label)
            .setLongLived(true)
            .setIcon(avatar)
            .setIntent(intent)
            .setPerson(Person.Builder().setName(label).setKey(id).setIcon(avatar).build())
            .build()
        ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
        return id
    }

    /** The conversation picture: full-bleed, with what matters inside the middle two-thirds (adaptive icon safe zone). */
    private fun avatar(color: Int, icon: Path?, pic: Bitmap?): Bitmap {
        val size = 216
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        if (pic != null) {
            c.drawBitmap(Bitmap.createScaledBitmap(pic, size, size, true), 0f, 0f, null)
            return bmp
        }
        if (icon != null) {
            c.drawColor(color)
            strokeIcon(c, size, icon, labelOn(color), 0.4f)
            return bmp
        }
        c.drawColor(Color.parseColor("#141b34"))
        val inner = largeIcon(color)
        val pad = (size - 128) / 2f
        c.drawBitmap(Bitmap.createScaledBitmap(inner, 128, 128, true), pad, pad, null)
        return bmp
    }

    /** The setting turned off: the mailbox shortcuts go, and notifications are plain again. */
    fun dropConversations(context: Context) {
        val ids = ShortcutManagerCompat.getDynamicShortcuts(context).map { it.id }.filter { it.startsWith("mailbox_") }
        if (ids.isNotEmpty()) runCatching { ShortcutManagerCompat.removeLongLivedShortcuts(context, ids) }
    }

    /** Mail read or moved elsewhere: its notifications go away here too. */
    fun clear(context: Context, tagsJson: String) {
        val tags = runCatching { JSONArray(tagsJson) }.getOrNull() ?: return
        val m = manager(context)
        for (i in 0 until tags.length()) m.cancel(tags.getString(i), 0)
    }
}
