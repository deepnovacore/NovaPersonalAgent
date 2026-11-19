import 'package:shared_preferences/shared_preferences.dart';

final class Preferences {
  Preferences(this.storage);
  final SharedPreferences storage;
  String language(String system) =>
      storage.getString('language') ?? (system.startsWith('zh') ? 'zh' : 'en');
  Future<void> saveLanguage(String language) async {
    await storage.setString('language', language);
  }

  bool get showProcess => storage.getBool('show_process') ?? true;
  Future<void> saveShowProcess(bool value) async {
    try {
      if (!await storage.setBool('show_process', value)) {
        throw StateError('preference_save_failed');
      }
    } catch (_) {
      // SharedPreferences updates its cache before the platform write succeeds.
      await storage.reload();
      rethrow;
    }
  }

  /// Old credentials and snapshots are deliberately left untouched for recovery.
  /// This client never reads them or reconnects to a Runtime.
  Future<void> retireRuntimeConnection() async {
    await storage.remove('server');
    await storage.remove('media');
  }
}
