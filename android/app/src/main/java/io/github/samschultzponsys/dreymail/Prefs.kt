// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.
// Modified by samschultzponsys, 2026-11-19: the conversation-notifications setting; which icon on each side (11.5).

package io.github.samschultzponsys.dreymail

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/** Small settings kept on the phone: server address, Firebase client values, account colours. */
object Prefs {
    fun of(context: Context): SharedPreferences = context.getSharedPreferences("dreymail", Context.MODE_PRIVATE)

    fun serverUrl(context: Context): String? = of(context).getString("server_url", null)

    fun setServerUrl(context: Context, url: String) = of(context).edit().putString("server_url", url).apply()

    fun firebase(context: Context): JSONObject? = of(context).getString("firebase", null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    fun setFirebase(context: Context, json: String) = of(context).edit().putString("firebase", json).apply()

    /** Notifications as conversations, with the mailbox's icon on the left (DreyMail 11.4). Off by default. */
    fun conversations(context: Context): Boolean = leftIcon(context) != "app"

    fun setConversations(context: Context, on: Boolean) = setLeftIcon(context, if (on) "mailbox" else "app")

    /**
     * What notifications show on the left (DreyMail 11.5): "app" (DreyMail's own icon, plain
     * notifications), or "mailbox", "group" or "color" (as a conversation).
     */
    fun leftIcon(context: Context): String =
        of(context).getString("left_icon", null) ?: if (of(context).getBoolean("conversations", false)) "mailbox" else "app"

    fun setLeftIcon(context: Context, v: String) = of(context).edit().putString("left_icon", v).apply()

    /** What notifications show on the right: "mailbox" (the default), "group", "color" or "none". */
    fun rightIcon(context: Context): String = of(context).getString("right_icon", null) ?: "mailbox"

    fun setRightIcon(context: Context, v: String) = of(context).edit().putString("right_icon", v).apply()
}
