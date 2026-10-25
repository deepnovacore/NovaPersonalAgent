import 'dart:convert';
import 'dart:io';
import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final path = Platform.environment['NOVA_LIVE_OUTPUT'];
  if (path == null || !Directory(path).existsSync()) {
    throw StateError(
      'Set NOVA_LIVE_OUTPUT to an existing external output directory',
    );
  }
  await integrationDriver(
    onScreenshot: (name, bytes, [args]) async {
      await File('$path/$name.png').writeAsBytes(bytes, flush: true);
      return true;
    },
    writeResponseOnFailure: true,
    responseDataCallback: (data) async {
      await File('$path/result.json').writeAsString(
        const JsonEncoder.withIndent('  ').convert(data),
        flush: true,
      );
    },
  );
}
