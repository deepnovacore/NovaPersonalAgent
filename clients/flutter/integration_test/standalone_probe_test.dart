import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'standalone_probe.dart';

void main() {
  test(
    'synthetic file persistence, approval, replay and unknown outcome probe',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'nova-standalone-',
      );
      try {
        expect(await runStandaloneProbe(directory), [
          'file_reopen_preserves_three_kinds_and_edit',
          'read_requires_no_approval_or_write',
          'denial_is_terminal_without_write',
          'approved_create_writes_once',
          'reopened_journal_replay_does_not_duplicate',
          'interrupted_intent_is_not_retried',
        ]);
      } finally {
        await directory.delete(recursive: true);
      }
    },
  );
}
