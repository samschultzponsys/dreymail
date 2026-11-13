// DreyMail. Copyright (C) 2026 samschultzponsys.
// Licensed under the GNU Affero General Public License v3.0 only; see LICENSE and NOTICE.

package io.github.samschultzponsys.dreymail

import android.content.Context
import android.util.Base64
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The phone's side of Web Push message encryption (RFC 8291, aes128gcm). The server encrypts every
 * notification to this phone's key, so Firebase (Google) relays only ciphertext.
 */
object WebPushCrypto {
    data class Keys(val p256dh: String, val auth: String)

    private const val PREF_PRIVATE = "push_private"
    private const val PREF_PUBLIC = "push_public"
    private const val PREF_AUTH = "push_auth"

    private fun b64u(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    private fun unb64u(s: String) = Base64.decode(s, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    /** This phone's keys, made once and kept. */
    fun keys(context: Context): Keys {
        val prefs = Prefs.of(context)
        val pub = prefs.getString(PREF_PUBLIC, null)
        val auth = prefs.getString(PREF_AUTH, null)
        if (pub != null && auth != null && prefs.getString(PREF_PRIVATE, null) != null) return Keys(pub, auth)
        val gen = KeyPairGenerator.getInstance("EC")
        gen.initialize(ECGenParameterSpec("secp256r1"))
        val pair = gen.generateKeyPair()
        val authBytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val keys = Keys(b64u(uncompressed(pair.public as ECPublicKey)), b64u(authBytes))
        prefs.edit()
            .putString(PREF_PRIVATE, Base64.encodeToString(pair.private.encoded, Base64.NO_WRAP))
            .putString(PREF_PUBLIC, keys.p256dh)
            .putString(PREF_AUTH, keys.auth)
            .apply()
        return keys
    }

    private fun unsigned32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
            else -> ByteArray(32 - b.size) + b
        }
    }

    private fun uncompressed(key: ECPublicKey): ByteArray =
        byteArrayOf(4) + unsigned32(key.w.affineX) + unsigned32(key.w.affineY)

    private fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        mac.update(info)
        mac.update(1.toByte())
        return mac.doFinal().copyOf(length)
    }

    /** Decrypts one aes128gcm message (base64) sent to this phone. */
    fun decrypt(context: Context, base64: String): String {
        val prefs = Prefs.of(context)
        val privateKey = KeyFactory.getInstance("EC")
            .generatePrivate(PKCS8EncodedKeySpec(Base64.decode(prefs.getString(PREF_PRIVATE, null), Base64.NO_WRAP))) as ECPrivateKey
        val uaPublic = unb64u(prefs.getString(PREF_PUBLIC, null)!!)
        val authSecret = unb64u(prefs.getString(PREF_AUTH, null)!!)

        val body = Base64.decode(base64, Base64.DEFAULT)
        val salt = body.copyOfRange(0, 16)
        val idLen = body[20].toInt() and 0xff
        val asPublic = body.copyOfRange(21, 21 + idLen)
        val ciphertext = body.copyOfRange(21 + idLen, body.size)

        // ECDH with the server's one-time key.
        val point = ECPoint(BigInteger(1, asPublic.copyOfRange(1, 33)), BigInteger(1, asPublic.copyOfRange(33, 65)))
        val serverKey = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, privateKey.params))
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(serverKey, true)
        val shared = agreement.generateSecret()

        val ikm = hkdf(authSecret, shared, "WebPush: info\u0000".toByteArray() + uaPublic + asPublic, 32)
        val cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\u0000".toByteArray(), 16)
        val nonce = hkdf(salt, ikm, "Content-Encoding: nonce\u0000".toByteArray(), 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        val padded = cipher.doFinal(ciphertext)
        // The plaintext ends with the 0x02 "last record" delimiter (and optional zero padding).
        var end = padded.size - 1
        while (end >= 0 && padded[end].toInt() == 0) end--
        return String(padded, 0, end, Charsets.UTF_8)
    }
}
