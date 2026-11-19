import Foundation
import Security
import CryptoKit

// Standard compact JWE dir/A256GCM. No custom cryptographic primitives or plaintext persistence.
enum NovaPushCrypto {
  static func bytes(_ text: String) -> Data? {
    let base = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    return Data(base64Encoded: base + String(repeating: "=", count: (4 - base.count % 4) % 4))
  }
  static func query(_ handle: String) -> [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "nova.space.push.v1", kSecAttrAccount as String: handle]
    if let group = Bundle.main.object(forInfoDictionaryKey: "NovaPushKeychainGroup") as? String, !group.isEmpty {
      q[kSecAttrAccessGroup as String] = group
    }
    return q
  }
  static func save(handle: String, encoded: String) throws {
    guard handle.count <= 128, let data = bytes(encoded), data.count == 32 else { throw Failure.invalid }
    var q = query(handle)
    SecItemDelete(q as CFDictionary)
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw Failure.invalid }
  }
  static func remove(handle: String) { SecItemDelete(query(handle) as CFDictionary) }
  static func decrypt(handle: String, compact: String) throws -> [String: String] {
    guard compact.utf8.count <= 3000 else { throw Failure.invalid }
    let parts = compact.components(separatedBy: ".")
    guard parts.count == 5, parts[1].isEmpty, let header = bytes(parts[0]),
      let object = try JSONSerialization.jsonObject(with: header) as? [String: Any],
      object["alg"] as? String == "dir", object["enc"] as? String == "A256GCM", object["zip"] == nil,
      let iv = bytes(parts[2]), iv.count == 12, let ciphertext = bytes(parts[3]), let tag = bytes(parts[4]), tag.count == 16 else { throw Failure.invalid }
    var q = query(handle); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let key = result as? Data, key.count == 32 else { throw Failure.invalid }
    let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ciphertext, tag: tag)
    let plaintext = try AES.GCM.open(sealed, using: SymmetricKey(data: key), authenticating: Data(parts[0].utf8))
    guard let notification = try JSONSerialization.jsonObject(with: plaintext) as? [String: String],
      let title = notification["title"], title.count <= 120, let body = notification["body"], body.count <= 1024 else { throw Failure.invalid }
    return ["title": title, "body": body]
  }
  enum Failure: Error { case invalid }
}
