import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/experience/author_model_dialog.dart';
import 'package:nova_mobile/experience/experience_session.dart';
import 'package:nova_mobile/space/space_storage.dart';

void main() {
  testWidgets('redeem and switch back only change the selected Space', (
    tester,
  ) async {
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
    );
    const id = 'test_install';
    var redemptions = 0;
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
    Future<void> open(String? selected) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showAuthorModelDialog(
                  context,
                  session: session,
                  space: space,
                  language: 'en',
                  selected: selected,
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

    await open(null);
    await tester.enterText(find.byType(TextField), 'expired');
    await tester.tap(find.text('Redeem and enable'));
    await tester.pumpAndSettle();
    expect(find.text('This code has expired.'), findsOneWidget);
    expect(await session.authorEnrollment(space), isNull);

    await tester.enterText(find.byType(TextField), 'invalid');
    await tester.tap(find.text('Redeem and enable'));
    await tester.pumpAndSettle();
    expect(find.text('Check the experience code.'), findsOneWidget);
    expect(await session.authorEnrollment(space), isNull);

    await tester.enterText(find.byType(TextField), 'valid');
    final submit = tester
        .widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Redeem and enable'),
        )
        .onPressed!;
    submit();
    submit();
    await tester.pumpAndSettle();
    expect(redemptions, 3);
    expect(tokenScopes, ['text']);
    expect(await session.authorEnrollment(other), isNull);
    expect(
      await ExperienceSession(request: request).authorEnrollment(space),
      id,
    );

    await open(id);
    await tester.tap(find.text('Use previous model'));
    await tester.pumpAndSettle();
    expect(await session.authorEnrollment(space), isNull);
    expect(await storage.read(key: 'original-provider'), 'keep');

    await open(null);
    await tester.tap(find.text('Enable'));
    await tester.pumpAndSettle();
    expect(await session.authorEnrollment(space), id);
    expect(redemptions, 3);
    final revoked = ExperienceSession(
      request: (_, _, _) async =>
          throw const ExperienceFailure('enrollment_inactive'),
    );
    addTearDown(revoked.dispose);
    await expectLater(
      revoked.setAuthorEnrollment(space, id),
      throwsA(isA<ExperienceFailure>()),
    );
    expect(await revoked.authorEnrollment(space), id);
    expect(await storage.read(key: 'original-provider'), 'keep');
    expect(await revoked.authorEnrollment(other), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
