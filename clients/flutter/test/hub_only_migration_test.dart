import 'dart:convert';
import 'package:nova_mobile/services/preferences.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'retiring Runtime settings preserves language and Hub settings',
    () async {
      SharedPreferences.setMockInitialValues({
        'server': 'wss://retired.example',
        'media': 'aoq',
        'language': 'zh',
        'hub': 'https://hub.example',
      });
      final storage = await SharedPreferences.getInstance();
      final preferences = Preferences(storage);
      await preferences.retireRuntimeConnection();
      expect(storage.getString('server'), isNull);
      expect(storage.getString('media'), isNull);
      expect(preferences.language('en'), 'zh');
      expect(storage.getString('hub'), 'https://hub.example');
      await preferences.saveLanguage('en');
      expect(preferences.language('zh'), 'en');
    },
  );
  test(
    'legacy computer conversations reopen locally without losing history',
    () async {
      final persistence = MemoryLifePersistence();
      await persistence.write(
        jsonEncode({
          'schema_version': 1,
          'conversations': [
            {
              'id': 'legacy',
              'backend': 'computer',
              'messages': [
                {
                  'role': 'user',
                  'content': 'Keep my history',
                  'time': '2026-10-18T00:00:00Z',
                },
              ],
            },
          ],
        }),
      );
      final store = ConversationStore(persistence);
      await store.open();
      expect(store.conversation('legacy')['backend'], 'local');
      expect(
        (store.conversation('legacy')['messages'] as List).single['content'],
        'Keep my history',
      );
      final reopened = ConversationStore(persistence);
      await reopened.open();
      expect(reopened.conversation('legacy')['backend'], 'local');
    },
  );
}
