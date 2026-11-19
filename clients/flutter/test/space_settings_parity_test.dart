import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:nova_mobile/experience/persona.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:nova_mobile/ui/settings_sheet.dart';
import 'experience_test.dart' show fixture;

void main() {
  testWidgets(
    'ordinary and persona Spaces expose the same settings',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      SharedPreferences.setMockInitialValues({'language': 'en'});
      FlutterSecureStorage.setMockInitialValues({});
      await ExperiencePersona.loadManifest(bundle: fixture());
      addTearDown(() {
        ExperiencePersona.choices = const [];
        SpaceStorage.active = null;
      });
      final entries = <Set<String>>[];
      for (final persona in [false, true]) {
        final space = SpaceRecord(
          id: persona ? 'sample-space' : 'ordinary-space',
          name: 'Test Space',
          mode: SpaceMode.standalone,
          personaId: persona ? 'sample' : null,
          experienceSeededAt: persona ? DateTime.utc(2026) : null,
        );
        SpaceStorage.active = space;
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) {
                final root =
                    (const NovaApp().build(context) as MaterialApp).home!
                        as SpaceRoot;
                return root.standalonePageBuilder!(space, () {});
              },
            ),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        await tester.tap(find.text('Me'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        await tester.tap(find.byTooltip('Settings'));
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        entries.add(
          tester
              .widgetList<SettingsGroup>(find.byType(SettingsGroup))
              .expand((group) => group.rows.map((row) => row.$1))
              .toSet(),
        );
        for (final key in [
          'model_services',
          'devices',
          'pet_avatar',
          'connectors',
          'local_schedules',
        ]) {
          expect(entries.last, contains(key), reason: 'persona: $persona');
        }
        await tester.tap(find.text('Model services'));
        await tester.pump();
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(find.text('Conversation model'), findsOneWidget);
        expect(find.text('Information processing'), findsOneWidget);
        await tester.tap(find.text('Voice services'));
        await tester.pump();
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
        expect(
          find.byKey(const ValueKey('pipeline.tab.integrated')),
          findsOneWidget,
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        await tester.pump(const Duration(seconds: 1));
      }
      expect(entries.last, entries.first);
    },
    variant: TargetPlatformVariant({TargetPlatform.iOS}),
  );
}
