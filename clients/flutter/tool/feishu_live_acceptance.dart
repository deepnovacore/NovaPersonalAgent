// Explicit development-only entry point for an owner-authorized app transfer.
// Normal lib/main.dart never reads an import file. No secrets are build inputs.
import 'dart:convert';
import 'dart:io';
import 'package:flutter/widgets.dart';
import 'package:path_provider/path_provider.dart';
import 'package:nova_mobile/connectors/feishu/auth.dart';
import 'package:nova_mobile/connectors/feishu/api.dart';
import 'package:nova_mobile/connectors/feishu/credentials.dart';
import 'package:nova_mobile/main.dart' as nova;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final directory = await getApplicationDocumentsDirectory();
  final input = File('${directory.path}/nova-feishu-acceptance-import.json');
  if (await input.exists()) {
    var outcome = 'failed';
    final auth = FeishuAuth(FeishuCredentialPersistence(), FeishuApi());
    try {
      if (await input.length() > 8192) throw StateError('invalid_import');
      final value = jsonDecode(await input.readAsString()) as Map;
      await auth.open();
      if (auth.configured) throw StateError('already_configured');
      await auth.bindApp(
        brand: value['brand'] as String,
        appId: value['app_id'] as String,
        secret: value['secret'] as String,
      );
      outcome = 'imported';
    } catch (_) {
      // Never log errors containing transferred data.
    } finally {
      await input.delete();
      auth.dispose();
    }
    await File(
      '${directory.path}/nova-feishu-acceptance-result.json',
    ).writeAsString(
      jsonEncode({'status': outcome, 'input_deleted': !await input.exists()}),
      flush: true,
    );
  }
  nova.main();
}
