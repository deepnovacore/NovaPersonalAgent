import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/app.dart';

void main() {
  ({String hint, bool connect}) hint({
    bool restored = true,
    bool configured = true,
    bool authorized = true,
    bool syncing = false,
    required String language,
  }) => profileEmptyHint(
    restored: restored,
    configured: configured,
    authorized: authorized,
    syncing: syncing,
    language: language,
  );

  test('unrestored local data says it is still opening', () {
    for (final (language, copy) in [
      ('zh', '正在读取本机资料…'),
      ('en', 'Opening local data…'),
    ]) {
      final result = hint(restored: false, language: language);
      expect(result.hint, copy);
      expect(result.connect, false);
    }
  });

  test('missing configuration asks to connect Feishu', () {
    for (final (language, copy) in [
      ('zh', '先连接飞书，之后会自动整理到这里。'),
      ('en', 'Connect Feishu and your updates will appear here.'),
    ]) {
      final result = hint(configured: false, language: language);
      expect(result.hint, copy);
      expect(result.connect, true);
    }
  });

  test('expired authorization asks to reconnect', () {
    for (final (language, copy) in [
      ('zh', '飞书授权已失效，重新连接后会自动整理。'),
      ('en', 'Feishu access expired. Reconnect to resume organizing.'),
    ]) {
      final result = hint(authorized: false, language: language);
      expect(result.hint, copy);
      expect(result.connect, true);
    }
  });

  test('active sync explains that organizing waits for it', () {
    for (final (language, copy) in [
      ('zh', '正在同步消息，完成后会自动整理。'),
      ('en', 'Syncing messages; updates will appear when it finishes.'),
    ]) {
      final result = hint(syncing: true, language: language);
      expect(result.hint, copy);
      expect(result.connect, false);
    }
  });

  test('a connected space with nothing showable explains Space isolation', () {
    for (final (language, copy) in [
      ('zh', '还没有可显示的近况。资料按 Space 隔离，其他 Space 的记录不会出现在这里。'),
      ('en', 'No updates available yet. Data is per-Space; records from other Spaces are not shown here.'),
    ]) {
      final result = hint(language: language);
      expect(result.hint, copy);
      expect(result.connect, false);
    }
  });

  test('the first applicable reason wins', () {
    expect(
      hint(restored: false, configured: false, authorized: false, language: 'zh')
          .hint,
      '正在读取本机资料…',
    );
    expect(
      hint(configured: false, authorized: false, syncing: true, language: 'zh')
          .hint,
      '先连接飞书，之后会自动整理到这里。',
    );
    expect(
      hint(authorized: false, syncing: true, language: 'zh').hint,
      '飞书授权已失效，重新连接后会自动整理。',
    );
  });
}
