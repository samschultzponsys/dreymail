// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

package io.github.samschultzponsys.dreymail

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/** Receives the server's (encrypted) messages through Firebase and shows or clears notifications. */
class PushService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val sealed = message.data["e"] ?: return
        val json = runCatching { JSONObject(WebPushCrypto.decrypt(this, sealed)) }.getOrNull() ?: return
        val data = json.keys().asSequence().associateWith { json.optString(it) }
        when (data["type"]) {
            "notify" -> Notifier.show(this, data)
            "clear" -> Notifier.clear(this, data["tags"] ?: "[]")
        }
    }

    /** Firebase rotated this phone's token: tell the server (with the login the app already has). */
    override fun onNewToken(token: String) {
        Server.registerToken(this, token)
    }
}
