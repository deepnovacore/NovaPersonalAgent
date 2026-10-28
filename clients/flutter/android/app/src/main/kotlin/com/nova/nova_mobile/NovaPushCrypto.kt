package com.nova.nova_mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal object NovaPushCrypto {
    private const val alias = "nova.space.push.wrapping.v1"
    private fun decode(text: String): ByteArray = Base64.decode(text, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    private fun encode(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    @Synchronized private fun wrappingKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    fun save(context: Context, handle: String, key: String) {
        require(handle.length in 1..128)
        val bytes = decode(key); require(bytes.size == 32)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        cipher.updateAAD(handle.toByteArray(Charsets.UTF_8))
        val wrapped = encode(cipher.iv) + "." + encode(cipher.doFinal(bytes))
        check(context.getSharedPreferences("nova_push_keys", Context.MODE_PRIVATE).edit().putString(handle, wrapped).commit())
    }
    fun remove(context: Context, handle: String) {
        context.getSharedPreferences("nova_push_keys", Context.MODE_PRIVATE).edit().remove(handle).commit()
    }
    fun decrypt(context: Context, handle: String, compact: String): Pair<String, String> {
        require(compact.toByteArray().size <= 3000)
        val parts = compact.split('.'); require(parts.size == 5 && parts[1].isEmpty())
        val header = JSONObject(String(decode(parts[0]), Charsets.UTF_8))
        require(header.optString("alg") == "dir" && header.optString("enc") == "A256GCM" && !header.has("zip"))
        val wrapped = context.getSharedPreferences("nova_push_keys", Context.MODE_PRIVATE).getString(handle, null)!!.split('.')
        val unwrap = Cipher.getInstance("AES/GCM/NoPadding")
        unwrap.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, decode(wrapped[0])))
        unwrap.updateAAD(handle.toByteArray(Charsets.UTF_8))
        val key = unwrap.doFinal(decode(wrapped[1]))
        val iv = decode(parts[2]); val tag = decode(parts[4]); require(iv.size == 12 && tag.size == 16)
        val plain = JSONObject(String(NovaPushJwe.decrypt(key, parts[0], iv, decode(parts[3]), tag), Charsets.UTF_8))
        val title = plain.getString("title"); val body = plain.getString("body")
        require(title.length <= 120 && body.length <= 1024)
        return Pair(title, body)
    }
}
