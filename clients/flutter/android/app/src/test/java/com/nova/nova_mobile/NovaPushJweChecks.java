package com.nova.nova_mobile;

import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Base64;

public final class NovaPushJweChecks {
    public static void main(String[] args) throws Exception {
        byte[] key = Base64.getUrlDecoder().decode(args[0]);
        String[] parts = args[1].split("\\.", -1);
        byte[] iv = Base64.getUrlDecoder().decode(parts[2]);
        byte[] encrypted = Base64.getUrlDecoder().decode(parts[3]);
        byte[] tag = Base64.getUrlDecoder().decode(parts[4]);
        byte[] result = NovaPushJwe.decrypt(key, parts[0], iv, encrypted, tag);
        if (!Arrays.equals(result, Base64.getUrlDecoder().decode(args[2]))) throw new AssertionError("JWE plaintext mismatch");
        byte[] changed = tag.clone(); changed[0] ^= 1;
        try { NovaPushJwe.decrypt(key, parts[0], iv, encrypted, changed); throw new AssertionError("tampered tag accepted"); }
        catch (GeneralSecurityException expected) { }
        try { NovaPushJwe.decrypt(key, parts[0] + "A", iv, encrypted, tag); throw new AssertionError("tampered AAD accepted"); }
        catch (GeneralSecurityException expected) { }
        try { NovaPushJwe.decrypt(key, parts[0], Arrays.copyOf(iv, 11), encrypted, tag); throw new AssertionError("invalid IV accepted"); }
        catch (GeneralSecurityException expected) { }
        System.out.println("PASS Android production JWE core: JOSE interop, tampered tag/AAD and IV bounds");
    }
}
