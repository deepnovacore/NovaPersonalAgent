import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:shared_preferences/shared_preferences.dart';
// ignore: depend_on_referenced_packages
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';

class FailingDisplayStore extends InMemorySharedPreferencesStore {
  FailingDisplayStore() : super.withData({'flutter.show_process': true});
  @override
  Future<bool> setValue(String valueType, String key, Object value) async =>
      false;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'message display defaults to full process and restores the saved choice',
    () async {
      SharedPreferences.setMockInitialValues({});
      final storage = await SharedPreferences.getInstance();
      expect(Preferences(storage).showProcess, isTrue);
      await Preferences(storage).saveShowProcess(false);
      await storage.reload();
      expect(Preferences(storage).showProcess, isFalse);
      await Preferences(storage).saveShowProcess(true);
      expect(Preferences(storage).showProcess, isTrue);
    },
  );
  test('failed display save keeps the old cached choice', () async {
    SharedPreferences.setMockInitialValues({'show_process': true});
    final storage = await SharedPreferences.getInstance();
    final previous = SharedPreferencesStorePlatform.instance;
    SharedPreferencesStorePlatform.instance = FailingDisplayStore();
    addTearDown(() => SharedPreferencesStorePlatform.instance = previous);
    final prefs = Preferences(storage);
    await expectLater(prefs.saveShowProcess(false), throwsStateError);
    expect(prefs.showProcess, isTrue);
  });
}
