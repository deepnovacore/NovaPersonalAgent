import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/experience/experience_code_dialog.dart';
import 'package:nova_mobile/experience/experience_session.dart';
import 'package:nova_mobile/space/space_storage.dart';

void main() {
  testWidgets(
    'experience code is shared between Spaces and survives reopening',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({'original-provider': 'keep'});
      const storage = FlutterSecureStorage();
      const space = SpaceRecord(
        id: 'first',
        name: 'First',
        mode: SpaceMode.standalone,
      );
      const other = SpaceRecord(
        id: 'second',
        name: 'Second',
        mode: SpaceMode.standalone,
        personaId: 'fixture-persona',
      );
      const id = 'test_install';
      var redemptions = 0;
      String? tokenFailure;
      final tokenScopes = <Object?>[];
      Future<Uint8List> request(
        Uri url,
        Map<String, Object>? body,
        String? bearer,
      ) async {
        final redeem = url.path.endsWith('/redeem');
        if (redeem) {
          redemptions++;
          if (body?['code'] == 'expired') {
            throw const ExperienceFailure('invite_expired');
          }
          if (body?['code'] != 'valid') {
            throw const ExperienceFailure('invalid_request');
          }
        } else {
          tokenScopes.add(body?['scope']);
          if (tokenFailure case final failure?) {
            throw ExperienceFailure(failure);
          }
        }
        return Uint8List.fromList(
          utf8.encode(
            jsonEncode({
              'tester_id': id,
              'expires_at': DateTime.now()
                  .add(const Duration(minutes: 4))
                  .millisecondsSinceEpoch,
              if (!redeem) 'token': 'a' * 43,
            }),
          ),
        );
      }

      final session = ExperienceSession(request: request);
      addTearDown(session.dispose);
      Future<void> open(SpaceRecord space, ExperienceSession owner) async {
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Builder(
                builder: (context) => TextButton(
                  onPressed: () => SpaceStorage.runScoped(
                    space,
                    () => showExperienceCodeDialog(
                      context,
                      session: owner,
                      language: 'en',
                    ),
                  ),
                  child: const Text('Open'),
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
      }

      await open(space, session);
      await tester.enterText(find.byType(TextField), 'expired');
      await tester.tap(find.text('Redeem code'));
      await tester.pumpAndSettle();
      expect(find.text('This code has expired.'), findsOneWidget);
      expect(await session.resumeInvite(), isNull);

      await tester.enterText(find.byType(TextField), 'invalid');
      await tester.tap(find.text('Redeem code'));
      await tester.pumpAndSettle();
      expect(find.text('Check the experience code.'), findsOneWidget);
      expect(await session.resumeInvite(), isNull);

      await tester.enterText(find.byType(TextField), 'valid');
      final submit = tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, 'Redeem code'),
          )
          .onPressed!;
      submit();
      submit();
      await tester.pumpAndSettle();
      expect(redemptions, 3);
      final restarted = ExperienceSession(request: request);
      addTearDown(restarted.dispose);
      await open(other, restarted);
      expect(
        find.text('All Spaces on this device can use the experience service.'),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsNothing);
      expect(find.text('Enable'), findsNothing);
      expect((await restarted.model()).key, 'a' * 43);
      expect(tokenScopes, ['text']);
      expect(await storage.read(key: 'original-provider'), 'keep');
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();

      final recovery = ExperienceSession(request: request);
      addTearDown(recovery.dispose);
      tokenFailure = 'unavailable';
      await open(other, recovery);
      expect(
        find.text(
          'Could not check access. Check your connection and try again.',
        ),
        findsOneWidget,
      );
      expect(find.byType(TextField), findsNothing);
      tokenFailure = 'enrollment_inactive';
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      expect(redemptions, 3);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
