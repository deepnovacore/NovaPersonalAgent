import 'package:flutter_test/flutter_test.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:nova_mobile/connectors/feishu/browser.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';

void main() {
  test(
    'external refusal falls back to system browser using the same official URL',
    () async {
      final uri = Uri.parse('https://accounts.feishu.cn/fixture');
      final modes = <LaunchMode>[];
      await openFeishuBrowser(
        uri,
        launcher: (value, {required mode}) async {
          expect(value, uri);
          modes.add(mode);
          return mode == LaunchMode.inAppBrowserView;
        },
      );
      expect(modes, [
        LaunchMode.externalApplication,
        LaunchMode.inAppBrowserView,
      ]);
    },
  );
  test('untrusted URL never reaches either browser', () async {
    var calls = 0;
    await expectLater(
      openFeishuBrowser(
        Uri.parse('https://untrusted.invalid'),
        launcher: (_, {required mode}) async {
          calls++;
          return true;
        },
      ),
      throwsA(isA<FeishuFailure>()),
    );
    expect(calls, 0);
  });
}
