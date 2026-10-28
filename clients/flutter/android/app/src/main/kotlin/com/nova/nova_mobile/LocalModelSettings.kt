package com.nova.nova_mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device-local, authenticated encryption; neither Hub nor task records receive the key. */
class LocalModelSettings(context: Context, private val spaceId: String) {
    private val file = AtomicFile(File(NovaSpaceScope.privateDirectory(context, spaceId), "agent-model-v1.enc"))
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("nova.agent.model.v1.$spaceId", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("nova.agent.model.v1.$spaceId", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun read(): ModelConfiguration? {
        if(!file.baseFile.exists()) return null
        val bytes = file.readFully()
        require(bytes.size in 29..32768)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0,12)))
        val value = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)), Charsets.UTF_8))
        return ModelConfiguration(value.getString("endpoint"),value.getString("model"),value.getString("key"),value.optString("protocol","chatCompletions"),value.optLong("expires_at",0))
    }
    @Synchronized fun save(value: JSONObject) {
        val old = read()
        val configuration = ModelConfiguration(value.getString("endpoint").trim(),value.getString("model").trim(),value.optString("key").ifBlank {
            require(old?.endpoint == value.getString("endpoint").trim()) { "key_required_for_new_endpoint" };old!!.key
        },value.optString("protocol","chatCompletions"),value.optLong("expires_at",0))
        val payload = JSONObject().put("endpoint",configuration.endpoint).put("model",configuration.model).put("key",configuration.key).put("protocol",configuration.protocol).put("expires_at",configuration.expiresAt).toString()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,key()) }
        val bytes = cipher.iv + cipher.doFinal(payload.toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try { stream.write(bytes);file.finishWrite(stream) } catch(error: Exception) { file.failWrite(stream);throw error }
    }
    @Synchronized fun clearChatGpt() { if(read()?.protocol == "chatgptResponses") file.delete() }
    fun status(): JSONObject {
        val value = read()
        return JSONObject().put("configured",value != null)
            .put("endpoint",value?.endpoint ?: "https://openrouter.ai/api/v1/chat/completions")
            .put("model",value?.model ?: "openai/gpt-4.1-mini")
    }
}
