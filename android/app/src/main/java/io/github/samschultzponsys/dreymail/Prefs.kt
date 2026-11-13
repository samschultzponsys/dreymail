// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

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
}
