import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var handler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?
  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    handler = contentHandler
    guard let copy = request.content.mutableCopy() as? UNMutableNotificationContent else { contentHandler(request.content); handler = nil; return }
    content = copy
    // Always force safe original content; even malformed/undecryptable pushes get the generic alert.
    copy.title = "Nova"; copy.body = "Open Nova to view new updates."
    if let handle = copy.userInfo["handle"] as? String, let encrypted = copy.userInfo["ciphertext"] as? String,
      let decoded = try? NovaPushCrypto.decrypt(handle: handle, compact: encrypted) {
      copy.title = decoded["title"] ?? "Nova"; copy.body = decoded["body"] ?? copy.body
    }
    finish()
  }
  override func serviceExtensionTimeWillExpire() { finish() }
  private func finish() { guard let handler, let content else { return }; self.handler = nil; handler(content) }
}
