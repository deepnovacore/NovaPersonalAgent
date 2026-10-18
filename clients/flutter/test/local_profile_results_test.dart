import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/context/profile_repository.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'package:nova_mobile/personal/models.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'package:nova_mobile/ui/local_profile_results.dart';
import 'package:nova_mobile/ui/workbench_page.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

class ReadyHost extends FeishuHost {
  ReadyHost(SourceStore sources) : super(sources: sources) {
    sources.addListener(notifyListeners);
  }
  @override
  bool get ready => true;
  @override
  void dispose() {
    sources.removeListener(notifyListeners);
    super.dispose();
  }
}

void main() {
  for (final expire in [false, true]) {
    testWidgets(
      'local results and open evidence disappear on ${expire ? 'expiry' : 'withdrawal'}',
      (tester) async {
        var now = DateTime.utc(2026, 10, 18);
        final sourceTime = now
            .subtract(const Duration(days: 30))
            .add(const Duration(seconds: 2));
        final sources = SourceStore(MemoryLifePersistence(), now: () => now);
        await sources.bind('self', 1);
        await sources.select('c', sourceTime);
        await sources.ingestPage(
          sources.fence('c'),
          [
            {
              'message_id': 'm',
              'sender': {'id_type': 'open_id', 'id': 'self'},
              'create_time': '${sourceTime.millisecondsSinceEpoch}',
              'msg_type': 'text',
              'body': {'content': '{"text":"synthetic original plan"}'},
            },
          ],
          nextPage: null,
          windowEnd: now,
        );
        await sources.grantProcessing('p', 'profile', true);
        final host = ReadyHost(sources);
        final authority = SpaceAuthorityRepository(MemoryLifePersistence());
        await authority.open();
        final disk = MemoryLifePersistence();
        final profile = ProfileRepository(disk, authority, sources);
        final ref = sources.messages('c').single['evidence_id'];
        await profile.publish(
          jsonEncode([
            {
              'key': 'about',
              'kind': 'profile',
              'text': 'Grounded profile',
              'evidence_ids': [ref],
            },
            {
              'key': 'event',
              'kind': 'timeline',
              'text': 'Grounded plan',
              'observed_at': sourceTime.toIso8601String(),
              'evidence_ids': [ref],
            },
          ]),
          epoch: authority.epoch,
          sourceRevision: sources.revision,
          consentRevision: sources.processingRevision,
          provider: 'p',
          incompleteBatches: 1,
        );
        final saved = disk.value;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: LocalProfileResults(
                  host: host,
                  authority: authority,
                  repository: profile,
                  kind: 'all',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('Grounded profile'), findsOneWidget);
        expect(find.textContaining('可能有遗漏'), findsOneWidget);
        expect(disk.value, saved);
        await tester.tap(find.text('Grounded plan'));
        await tester.pumpAndSettle();
        expect(find.text('synthetic original plan'), findsOneWidget);
        if (expire) {
          now = now.add(const Duration(seconds: 3));
          await tester.pump(const Duration(seconds: 3));
        } else {
          await sources.grantProcessing('p', 'profile', false);
        }
        await tester.pumpAndSettle();
        expect(find.text('synthetic original plan'), findsNothing);
        expect(find.textContaining('当前依据不再可用'), findsOneWidget);
        await tester.tap(find.text('关闭'));
        await tester.pumpAndSettle();
        expect(find.text('Grounded profile'), findsNothing);
        await tester.pumpWidget(const SizedBox());
        host.dispose();
        authority.dispose();
      },
    );
  }
  testWidgets('an explicitly cleared introduction suppresses inferred about', (
    tester,
  ) async {
    final store = PersonalStore(send: (_) => false)
      ..restore(
        PersonalSnapshot({
          'revision': 1,
          'life': {
            'profile': {'version': 1, 'about': ''},
          },
        }),
      );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: WorkbenchPage(
            store: store,
            page: 5,
            onSettings: () {},
            localProfile: (excludeAbout) =>
                Text(excludeAbout ? 'explicit wins' : 'inferred about'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('explicit wins'), findsOneWidget);
    expect(find.text('inferred about'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    store.dispose();
  });
}
