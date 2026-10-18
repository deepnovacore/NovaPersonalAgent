import 'package:shared_preferences/shared_preferences.dart';

final class Preferences {
  Preferences(this.storage);
  final SharedPreferences storage;
  String language(String system) =>
      storage.getString('language') ?? (system.startsWith('zh') ? 'zh' : 'en');
  Future<void> saveLanguage(String language) async {
    await storage.setString('language', language);
  }

  /// Old credentials and snapshots are deliberately left untouched for recovery.
  /// This client never reads them or reconnects to a Runtime.
  Future<void> retireRuntimeConnection() async {
    await storage.remove('server');
    await storage.remove('media');
  }
}
