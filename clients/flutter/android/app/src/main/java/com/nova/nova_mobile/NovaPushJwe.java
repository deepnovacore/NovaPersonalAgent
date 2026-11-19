package com.nova.nova_mobile;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Platform-independent authenticated-decryption core, shared by Android and JVM contract checks. */
public final class NovaPushJwe {
    private NovaPushJwe() {}
    public static byte[] decrypt(byte[] key, String header, byte[] iv, byte[] ciphertext, byte[] tag) throws GeneralSecurityException {
        if (key.length != 32 || iv.length != 12 || tag.length != 16 || header.length() > 256 || ciphertext.length > 3000) {
            throw new GeneralSecurityException("invalid_jwe");
        }
        byte[] sealed = new byte[ciphertext.length + tag.length];
        System.arraycopy(ciphertext, 0, sealed, 0, ciphertext.length);
        System.arraycopy(tag, 0, sealed, ciphertext.length, tag.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        cipher.updateAAD(header.getBytes(StandardCharsets.US_ASCII));
        return cipher.doFinal(sealed);
    }
}
