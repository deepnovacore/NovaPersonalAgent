import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/ui/provider_setup_page.dart';
import 'package:nova_mobile/ui/provider_credentials_sheet.dart';
import 'package:nova_mobile/ui/theme.dart';

import 'support/fake_model_http.dart';

// These tests drive the real provider setup page, LocalModelSettingsBackend,
// model listing and tool probe. Only the network is replaced.

class _Models extends ModelSettings {
  _Models(this.saved);
  final ModelConfiguration? saved;
  Map<String, Object?>? last;

  @override
  Future<ModelConfiguration?> read() async => saved;

  @override
  Future<void> save({
    required String endpoint,
    required String model,
    required String key,
    String? credentialId,
    ModelProtocol protocol = ModelProtocol.chatCompletions,
  }) async {
    last = {
      'endpoint': endpoint,
      'model': model,
      'key': key,
      'protocol': protocol,
    };
  }
}

Future<void> _open(
  WidgetTester tester,
  _Models models, {
  bool support = false,
}) async {
  FlutterSecureStorage.setMockInitialValues({
    if (models.saved != null)
      ModelSettings.storageKey: jsonEncode({
        'endpoint': models.saved!.endpoint,
        'model': models.saved!.model,
        'key': models.saved!.key,
      }),
  });
  tester.view.physicalSize = const Size(800, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: novaTheme(),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => support
                ? showLocalModelSettings(context, models, support: true)
                : showProviderCredentials(context, models.credentials),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

/// A device that already has a key shows its providers first; the form for
/// adding or re-testing one is a tap away.
Future<void> _openForm(WidgetTester tester) async {
  final add = find.byKey(const ValueKey('provider.add'));
  if (add.evaluate().isEmpty) return;
  await tester.tap(add);
  await tester.pumpAndSettle();
}

Finder _field(String name) => find.byKey(ValueKey(name));

String _keyText(WidgetTester tester) =>
    tester.widget<TextField>(_field('provider.key')).controller!.text;

bool _canTest(WidgetTester tester) =>
    tester.widget<FilledButton>(_field('provider.test')).onPressed != null;

Future<void> _type(WidgetTester tester, String name, String text) async {
  await tester.enterText(_field(name), text);
  await tester.pump();
}

Future<void> _chip(WidgetTester tester, String id) async {
  await tester.tap(_field('provider.chip.$id'));
  await tester.pumpAndSettle();
}

/// Starts "Test and save" and lets it reach the network.
Future<void> _test(WidgetTester tester) async {
  await tester.tap(_field('provider.test'));
  await tester.pump();
}

void main() {
  testWidgets(
    'support editor saves a separate route using a saved provider key',
    (tester) async {
      final models = _Models(null);
      await _open(tester, models, support: true);
      await models.credentials.save(
        endpoint: 'https://openrouter.ai/api/v1',
        key: 'support-key',
      );
      expect(find.text('信息整理'), findsOneWidget);
      expect(find.byKey(const ValueKey('support.follow')), findsOneWidget);
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(
        (await models.readSupportDraft())!['model'],
        'openai/gpt-4.1-mini',
      );
      expect(models.last, isNull);
    },
  );

  testWidgets('a new user sees a preset form: key only, no URL field', (
    tester,
  ) async {
    final http = installModelHttp();
    final models = _Models(null);
    await _open(tester, models);
    expect(find.byType(ProviderSetupPage), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget); // the key
    expect(find.text('接口地址'), findsNothing);
    expect(_field('provider.baseUrl'), findsNothing);
    expect(_field('provider.model'), findsNothing);
    await _type(tester, 'provider.key', 'sk-1');
    await _test(tester);
    await http.lists.single.complete(tester, ['openai/gpt-4.1-mini']);
    await http.probes.single.callTool(tester);
    expect(models.last, isNull);
    expect(
      (await models.credentials.resolve('https://openrouter.ai/api/v1'))!.key,
      'sk-1',
    );
    expect(await models.readApiKey(), isNull);
  });

  testWidgets('choosing another preset swaps endpoint and recommended model', (
    tester,
  ) async {
    final http = installModelHttp();
    final models = _Models(null);
    await _open(tester, models);
    await _chip(tester, 'deepseek');
    await _type(tester, 'provider.key', 'sk-2');
    await _test(tester);
    expect(http.lists.single.url.toString(), 'https://api.deepseek.com/models');
    await http.lists.single.complete(tester, []);
    // No list: the recommended model for this provider is offered.
    expect(
      tester.widget<TextField>(_field('provider.model')).controller!.text,
      'deepseek-flash',
    );
    await _test(tester);
    await http.lists.last.complete(tester, []);
    expect(http.probes.single.headers.values['Authorization'], 'Bearer sk-2');
    await http.probes.single.callTool(tester);
    expect(models.last, isNull);
    expect(
      (await models.credentials.resolve('https://api.deepseek.com'))!.key,
      'sk-2',
    );
    expect(await models.readApiKey(), isNull);
  });

  testWidgets('custom keeps the free-form fields and a blank key', (
    tester,
  ) async {
    final http = installModelHttp();
    final models = _Models(
      ModelConfiguration(
        endpoint: 'https://model.example/v1/chat/completions',
        model: 'm',
        key: 'saved',
      ),
    );
    await _open(tester, models);
    await _openForm(tester);
    expect(find.text('接口地址'), findsOneWidget);
    expect(find.text('自定义（OpenAI 兼容）'), findsOneWidget);
    expect(
      tester.widget<ChoiceChip>(_field('provider.chip.custom')).selected,
      isTrue,
    );
    expect(_keyText(tester), isEmpty);
    await _test(tester);
    expect(http.lists.single.headers.values['Authorization'], 'Bearer saved');
    await http.lists.single.complete(tester, ['m']);
    await http.probes.single.callTool(tester);
    expect(models.last, isNull);
    expect(
      (await models.readApiKey())!.endpoint,
      'https://model.example/v1/chat/completions',
    );
    expect((await models.readApiKey())!.key, 'saved');
  });

  testWidgets('a saved preset endpoint reopens on that preset unchanged', (
    tester,
  ) async {
    final http = installModelHttp();
    final models = _Models(
      ModelConfiguration(
        endpoint: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-reasoner',
        key: 'saved',
      ),
    );
    await _open(tester, models);
    await _openForm(tester);
    expect(
      tester.widget<ChoiceChip>(_field('provider.chip.deepseek')).selected,
      isTrue,
    );
    expect(find.text('接口地址'), findsNothing);
    expect(_field('provider.baseUrl'), findsNothing);
    await _test(tester);
    // A newer model is listed too; the one in use is still tried first.
    await http.lists.single.complete(tester, [
      'deepseek-v9',
      'deepseek-reasoner',
    ]);
    expect(http.probes.single.body, contains('"model":"deepseek-reasoner"'));
    await http.probes.single.callTool(tester);
    // Endpoint text is preserved so the stored key is still retained.
    expect(
      (await models.readApiKey())!.endpoint,
      'https://api.deepseek.com/chat/completions',
    );
    expect((await models.readApiKey())!.model, 'deepseek-reasoner');
    expect(models.last, isNull);
  });

  testWidgets('switching provider clears an explicitly entered key', (
    tester,
  ) async {
    final http = installModelHttp();
    final models = _Models(null);
    await _open(tester, models);
    await _type(tester, 'provider.key', 'old-provider-key');
    await _chip(tester, 'deepseek');
    expect(_keyText(tester), isEmpty);
    // Without a key of its own the new provider cannot be tested or saved.
    expect(_canTest(tester), isFalse);
    await tester.tap(_field('provider.test'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(http.lists, isEmpty);
    expect(http.probes, isEmpty);
    expect(models.last, isNull);
  });

  testWidgets(
    'editing a custom URL clears typed key and prevents saved key reuse',
    (tester) async {
      final http = installModelHttp();
      final models = _customModels();
      await _open(tester, models);
      await _openForm(tester);
      await _type(tester, 'provider.key', 'typed-key');
      await _type(tester, 'provider.baseUrl', 'https://other.example/v1');
      expect(_keyText(tester), isEmpty);
      expect(_canTest(tester), isFalse);
      await tester.tap(_field('provider.test'), warnIfMissed: false);
      await tester.pumpAndSettle();
      expect(http.lists, isEmpty);
      expect(http.probes, isEmpty);
      expect(models.last, isNull);
      // Typing a key for the new address is what enables the test.
      await _type(tester, 'provider.key', 'other-key');
      expect(_canTest(tester), isTrue);
    },
  );

  testWidgets(
    'loading models reuses a saved key only at the unchanged endpoint',
    (tester) async {
      final http = installModelHttp();
      final models = _customModels();
      await _open(tester, models);
      await _openForm(tester);
      await _test(tester);
      expect(
        http.lists.single.headers.values['Authorization'],
        'Bearer saved-key',
      );
      await http.lists.single.complete(tester, ['public-model']);
      expect(
        http.probes.single.headers.values['Authorization'],
        'Bearer saved-key',
      );
      await http.probes.single.callTool(tester);
      expect(models.last, isNull);
      expect((await models.readApiKey())!.model, 'm');
      expect((await models.readApiKey())!.endpoint, 'https://model.example/v1');
    },
  );

  for (final ids in [
    <String>[],
    ['public-model'],
  ]) {
    testWidgets(
      'a public model list does not claim a key is valid (${ids.length} models)',
      (tester) async {
        final http = installModelHttp();
        final models = _Models(null);
        await _open(tester, models);
        await _type(tester, 'provider.key', 'invalid-key');
        await _test(tester);
        await http.lists.single.complete(tester, ids);
        if (ids.isEmpty) {
          expect(_field('provider.noList'), findsOneWidget);
          expect(http.probes, isEmpty);
          await _test(tester); // the recommended model name is filled in
          await http.lists.last.complete(tester, []);
        }
        // Listing alone proves nothing: only a real call can accept the key.
        expect(
          http.probes.single.headers.values['Authorization'],
          'Bearer invalid-key',
        );
        await http.probes.single.reject(tester, 401);
        expect(_field('provider.failed'), findsOneWidget);
        expect(find.textContaining('API Key 无效或没有权限'), findsOneWidget);
        expect(find.textContaining('验证通过'), findsNothing);
        expect(find.textContaining('密钥可用'), findsNothing);
        expect(models.last, isNull);
        expect(find.byType(ProviderSetupPage), findsOneWidget);
      },
    );
  }

  for (final status in [200, 401]) {
    testWidgets('changing key discards an older model result ($status)', (
      tester,
    ) async {
      final http = installModelHttp();
      final models = _Models(null);
      await _open(tester, models);
      await _type(tester, 'provider.key', 'first-key');
      await _test(tester);
      await _type(tester, 'provider.key', 'second-key');
      expect(_canTest(tester), isTrue);
      await _test(tester);
      expect(http.lists, hasLength(2));
      expect(
        http.lists.last.headers.values['Authorization'],
        'Bearer second-key',
      );
      await http.lists.last.complete(tester, ['current-model']);
      expect(http.probes, hasLength(1));
      await http.lists.first.complete(tester, [
        'stale-model',
        'another-stale-model',
      ], status: status);
      // The older result neither probes its models nor reports its failure.
      expect(http.probes, hasLength(1));
      expect(http.probes.single.body, contains('"model":"current-model"'));
      expect(_field('provider.failed'), findsNothing);
      expect(find.textContaining('API Key 无效或没有权限'), findsNothing);
      expect(find.text('stale-model'), findsNothing);
      await http.probes.single.callTool(tester);
      expect(models.last, isNull);
      expect(
        (await models.credentials.resolve('https://openrouter.ai/api/v1'))!.key,
        'second-key',
      );
      expect(await models.readApiKey(), isNull);
    });
  }

  testWidgets('changing a custom URL discards its in-flight model list', (
    tester,
  ) async {
    final http = installModelHttp();
    final models = _customModels();
    await _open(tester, models);
    await _openForm(tester);
    await _test(tester);
    await _type(tester, 'provider.baseUrl', 'https://other.example/v1');
    await http.lists.single.complete(tester, ['stale-model']);
    // Nothing from the old address is probed, shown or saved.
    expect(http.probes, isEmpty);
    expect(find.text('stale-model'), findsNothing);
    expect(_field('provider.noList'), findsNothing);
    expect(_field('provider.failed'), findsNothing);
    expect(models.last, isNull);
    // The saved key does not follow the address, so it cannot be retested.
    expect(_keyText(tester), isEmpty);
    expect(_canTest(tester), isFalse);
    await tester.tap(_field('provider.test'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(http.lists, hasLength(1));
  });
}

_Models _customModels() => _Models(
  ModelConfiguration(
    endpoint: 'https://model.example/v1',
    model: 'm',
    key: 'saved-key',
  ),
);
