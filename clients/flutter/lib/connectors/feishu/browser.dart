import 'package:url_launcher/url_launcher.dart';
import 'api.dart';

typedef FeishuUrlLauncher =
    Future<bool> Function(Uri uri, {required LaunchMode mode});

/// Some iOS contexts refuse external launches; use the system browser sheet.
Future<void> openFeishuBrowser(Uri uri, {FeishuUrlLauncher? launcher}) async {
  if (uri.scheme != 'https' ||
      uri.userInfo.isNotEmpty ||
      uri.port != 443 ||
      ![
        'accounts.feishu.cn',
        'open.feishu.cn',
        'accounts.larksuite.com',
        'open.larksuite.com',
      ].contains(uri.host)) {
    throw const FeishuFailure('invalid_verification_url');
  }
  final open =
      launcher ??
      (Uri uri, {required LaunchMode mode}) => launchUrl(uri, mode: mode);
  if (await open(uri, mode: LaunchMode.externalApplication)) return;
  if (await open(uri, mode: LaunchMode.inAppBrowserView)) return;
  throw const FeishuFailure('browser_unavailable');
}
