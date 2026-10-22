import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';
import 'package:nova_mobile/agent_core/workspace_posix.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('device migration preserves originals and edited destinations', (
    tester,
  ) async {
    final root = await Directory.systemTemp.createTemp('nova-migration-');
    try {
      final legacy = File('${root.path}/legacy.json');
      final original = jsonEncode({
        'schema_version': 1,
        'items': {
          'new': {'html': '<p>original</p>'},
          'edited': {'html': '<p>old</p>'},
        },
      });
      await legacy.writeAsString(original);
      final workspace = AgentWorkspace(Directory('${root.path}/workspace'));
      await workspace.write('artifacts/edited/index.html', '<p>keep edit</p>');
      await workspace.migrateLegacy(legacy);
      expect(
        (await workspace.read('artifacts/new/index.html'))['content'],
        '<p>original</p>',
      );
      expect(
        (await workspace.read('artifacts/edited/index.html'))['content'],
        '<p>keep edit</p>',
      );
      expect(await legacy.readAsString(), original);
      await File('${workspace.root.path}/artifacts/new/index.html').delete();
      await AgentWorkspace(workspace.root).migrateLegacy(legacy);
      expect(
        await File('${workspace.root.path}/artifacts/new/index.html').exists(),
        false,
      );
    } finally {
      await root.delete(recursive: true);
    }
  });

  testWidgets('device atomic install never replaces an existing file', (
    tester,
  ) async {
    final root = await Directory.systemTemp.createTemp('nova-install-');
    final directory = WorkspaceDirectory.openRoot(root.path);
    try {
      directory.atomicWrite('value', utf8.encode('first'), onlyIfMissing: true);
      directory.atomicWrite(
        'value',
        utf8.encode('second'),
        onlyIfMissing: true,
      );
      expect(await File('${root.path}/value').readAsString(), 'first');
      expect((directory.listing()['entries'] as List).length, 1);
    } finally {
      directory.close();
      await root.delete(recursive: true);
    }
  });
}
