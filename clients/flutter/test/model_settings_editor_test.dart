import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_presets.dart';
import 'package:nova_mobile/settings/model_settings_backend.dart';
import 'package:nova_mobile/ui/model_settings_editor.dart';

class _Backend extends ModelSettingsBackend {
  _Backend({
    this.readOnly = false,
    this.unselected = false,
    this.failSave = false,
    this.extraProviders = const [],
  });
  final bool readOnly, unselected, failSave;
  final List<ModelPreset> extraProviders;
  ModelSettingsInput? saved;
  var followed = false;

  @override
  Future<ModelSettingsView> load() async => ModelSettingsView(
    providerId: unselected ? null : 'host-provider',
    endpoint: '',
    model: unselected ? '' : 'host-model',
    providers: [
      const ModelPreset(
        id: 'host-provider',
        name: 'Host provider',
        endpoint: '',
        recommendedModels: ['host-model'],
        keyUrl: '',
      ),
      ...extraProviders,
    ],
    customEndpoint: false,
    modelDiscovery: false,
    canFollow: true,
    readOnly: readOnly,
    securityText: 'Keys are sent securely to the paired Host.',
    notice: 'Restart running tasks to apply changes.',
  );

  @override
  Future<bool> hasCredential(String? providerId, String endpoint) async => true;

  @override
  Future<void> save(ModelSettingsInput input) async {
    if (failSave) throw StateError('save failed');
    saved = input;
  }

  @override
  Future<void> follow() async => followed = true;
}

Future<void> _open(WidgetTester tester, _Backend backend) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showModelSettingsEditor(
              context,
              backend,
              language: 'en',
              title: 'Host chat model',
              description: 'Follow the Host chat model.',
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

void main() {
  for (final newKey in ['', 'new-write-only-key']) {
    testWidgets('shared form saves metadata and write-only input ($newKey)', (
      tester,
    ) async {
      final backend = _Backend();
      await _open(tester, backend);
      expect(find.text('Host chat model'), findsOneWidget);
      expect(find.text('API key: Configured'), findsOneWidget);
      expect(find.text('API URL'), findsNothing);
      expect(find.text('API protocol'), findsNothing);
      expect(find.text('Load model list'), findsNothing);
      expect(find.text('Continue with ChatGPT'), findsNothing);
      expect(find.text('Manage provider credentials'), findsNothing);
      expect(
        find.text('Keys are sent securely to the paired Host.'),
        findsOneWidget,
      );
      final key = find.byWidgetPredicate(
        (widget) => widget is TextField && widget.obscureText,
      );
      expect(tester.widget<TextField>(key).controller!.text, isEmpty);
      await tester.enterText(key, newKey);
      await tester.enterText(
        find.widgetWithText(TextField, 'Model name'),
        'changed-model',
      );
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(backend.saved!.providerId, 'host-provider');
      expect(backend.saved!.model, 'changed-model');
      expect(backend.saved!.newKey, newKey);
    });
  }

  testWidgets('shared form follows through the backend', (tester) async {
    final backend = _Backend();
    await _open(tester, backend);
    await tester.ensureVisible(find.byKey(const ValueKey('support.follow')));
    await tester.tap(find.byKey(const ValueKey('support.follow')));
    await tester.pumpAndSettle();
    expect(backend.followed, true);
    expect(backend.saved, isNull);
  });

  testWidgets('unset Host selection offers providers without custom URL', (
    tester,
  ) async {
    final backend = _Backend(unselected: true);
    await _open(tester, backend);
    expect(find.text('Not configured'), findsOneWidget);
    await tester.ensureVisible(find.byType(DropdownButtonFormField<String>));
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    expect(find.text('Custom (OpenAI-compatible)'), findsNothing);
    await tester.tap(find.text('Host provider').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(backend.saved!.providerId, 'host-provider');
    expect(backend.saved!.model, 'host-model');
  });

  testWidgets('the compact editor names providers in the reader\'s language '
      'and hides those iOS cannot chat with', (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final backend = _Backend(
      unselected: true,
      extraProviders: [
        ModelPreset.byId('zhipu')!,
        ModelPreset.byId('opencode-go')!,
      ],
    );
    await _open(tester, backend);
    await tester.ensureVisible(find.byType(DropdownButtonFormField<String>));
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    expect(find.text('Zhipu GLM'), findsOneWidget);
    expect(find.text('智谱 GLM'), findsNothing);
    expect(find.text('OpenCode Go'), findsNothing);
    await tester.tap(find.text('Host provider').last);
    await tester.pumpAndSettle();
    debugDefaultTargetPlatformOverride = null;
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byType(DropdownButtonFormField<String>));
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    expect(find.text('OpenCode Go'), findsOneWidget);
  });

  testWidgets('Host save error names the visible provider and model fields', (
    tester,
  ) async {
    await _open(tester, _Backend(failSave: true));
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Could not save. Check the provider, model name and key, then retry.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('API URL'), findsNothing);
  });

  testWidgets('readonly model settings retain Cancel and disable writes', (
    tester,
  ) async {
    final backend = _Backend(readOnly: true);
    await _open(tester, backend);
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Save'))
          .onPressed,
      isNull,
    );
    expect(
      tester
          .widget<TextButton>(find.byKey(const ValueKey('support.follow')))
          .onPressed,
      isNull,
    );
    expect(
      tester
          .widgetList<TextField>(find.byType(TextField))
          .every((field) => field.enabled == false),
      true,
    );
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Host chat model'), findsNothing);
    expect(backend.saved, isNull);
    expect(backend.followed, false);
  });
}
