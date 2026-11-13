// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

package io.github.samschultzponsys.dreymail

import android.app.Application
import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions

class DreyMailApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.ensureGeneral(this)
        initFirebase(this)
    }

    companion object {
        /**
         * Firebase is set up from the values the DreyMail server hands out (Settings → Android), not
         * from a file baked into the app, so one APK works with anyone's server.
         */
        fun initFirebase(context: Context): Boolean {
            if (FirebaseApp.getApps(context).isNotEmpty()) return true
            val f = Prefs.firebase(context) ?: return false
            val options = FirebaseOptions.Builder()
                .setProjectId(f.optString("projectId"))
                .setApplicationId(f.optString("appId"))
                .setApiKey(f.optString("apiKey"))
                .setGcmSenderId(f.optString("senderId"))
                .build()
            return runCatching { FirebaseApp.initializeApp(context, options) }.isSuccess
        }
    }
}
