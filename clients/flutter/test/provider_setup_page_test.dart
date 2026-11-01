import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_catalog.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_presets.dart';
import 'package:nova_mobile/agent_core/model_probe.dart';
import 'package:nova_mobile/settings/model_settings_backend.dart';
import 'package:nova_mobile/ui/model_settings_editor.dart';
import 'package:nova_mobile/ui/provider_setup_page.dart';
import 'package:nova_mobile/ui/theme.dart';

const _openRouter = 'https://openrouter.ai/api/v1';

class _Backend extends ModelSettingsBackend {
  _Backend({
    this.endpoint = _openRouter,
    this.model = 'openai/gpt-4.1-mini',
    Set<String>? keyed,
    List<SavedProvider>? saved,
  }) : keyed = keyed ?? {},
       saved = saved ?? [];
  String endpoint, model;
  final Set<String> keyed;
  final List<SavedProvider> saved;
  final listCalls = <ModelSettingsInput>[];
  final probeCalls = <ModelSettingsInput>[];
  final saves = <ModelSettingsInput>[];
  final credentialSaves = <ModelSettingsInput>[];
  final deleted = <String>[];
  ModelListResult Function(ModelSettingsInput) lister = (_) =>
      const ModelListOk([]);
  ProbeResult Function(ModelSettingsInput) prober = (_) =>
      const ProbeToolCalled();
  Future<void>? gate;

  @override
  Future<ModelSettingsView> load() async => ModelSettingsView(
    providerId: ModelPreset.forEndpoint(endpoint)?.id,
    endpoint: endpoint,
    model: model,
  );

  @override
  Future<bool> hasCredential(String? providerId, String endpoint) async =>
      keyed.contains(endpoint);

  @override
  Future<ModelListResult> listModelsDetailed(ModelSettingsInput input) async {
    listCalls.add(input);
    await gate;
    return lister(input);
  }

  @override
  Future<ProbeResult> probe(ModelSettingsInput input) async {
    probeCalls.add(input);
    return prober(input);
  }

  @override
  Future<void> save(ModelSettingsInput input) async {
    saves.add(input);
    endpoint = input.endpoint;
    model = input.model;
    keyed.add(input.endpoint);
    _remember(input);
  }

  @override
  Future<void> saveCredential(ModelSettingsInput input) async {
    credentialSaves.add(input);
    keyed.add(input.endpoint);
    _remember(input);
  }

  void _remember(ModelSettingsInput input) {
    if (saved.any((p) => p.endpoint == input.endpoint)) return;
    saved.add(
      SavedProvider(
        id: 'id-${saved.length}',
        endpoint: input.endpoint,
        label: ModelPreset.forEndpoint(input.endpoint)?.name ?? 'Custom',
      ),
    );
  }

  @override
  Future<List<SavedProvider>> savedProviders() async => List.of(saved);

  @override
  Future<void> deleteProvider(String id) async {
    deleted.add(id);
    saved.removeWhere((p) => p.id == id);
  }
}

ListedModel _m(String id, {bool? tools}) =>
    ListedModel(id: id, toolCalls: tools);

Future<void> _open(
  WidgetTester tester,
  _Backend backend, {
  String language = 'zh',
  Future<bool> Function(BuildContext)? onChatGpt,
  Future<void> Function(BuildContext)? onManageCredentials,
  Size size = const Size(800, 2600),
  double textScale = 1,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: novaTheme(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(
          context,
        ).copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showModelSettingsEditor(
              context,
              backend,
              language: language,
              onChatGpt: onChatGpt,
              onManageCredentials: onManageCredentials,
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

Finder _key(String name) => find.byKey(ValueKey(name));
Future<void> _type(WidgetTester tester, String name, String text) async {
  await tester.enterText(_key(name), text);
  await tester.pump();
}

Future<void> _chip(WidgetTester tester, String id) async {
  await tester.tap(_key('provider.chip.$id'));
  await tester.pumpAndSettle();
}

Future<void> _test(WidgetTester tester) async {
  await tester.tap(_key('provider.test'));
  await tester.pumpAndSettle();
}

bool _enabled(WidgetTester tester) =>
    tester.widget<FilledButton>(_key('provider.test')).onPressed != null;

void main() {
  testWidgets('a device-owned model editor opens the full page, not a dialog', (
    tester,
  ) async {
    await _open(tester, _Backend());
    expect(find.byType(ProviderSetupPage), findsOneWidget);
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('配置模型'), findsOneWidget);
    expect(find.text('填 API Key'), findsOneWidget);
    // Chips are tiled with Wrap, one per preset plus Custom.
    final wrap = find.ancestor(
      of: _key('provider.chip.deepseek'),
      matching: find.byType(Wrap),
    );
    expect(wrap, findsOneWidget);
    expect(
      find.descendant(of: wrap, matching: find.byType(ChoiceChip)),
      findsNWidgets(modelPresets.length + 1),
    );
    for (final preset in modelPresets) {
      expect(find.text(preset.name), findsWidgets, reason: preset.id);
    }
    expect(_key('provider.baseUrl'), findsNothing);
    expect(_key('provider.model'), findsNothing);
    expect(find.text('用账号登录 · 不用填 Key'), findsNothing);
    // Back returns to the caller.
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.byType(ProviderSetupPage), findsNothing);
  });

  testWidgets('the ChatGPT sign-in group reuses the supplied sign-in', (
    tester,
  ) async {
    var calls = 0;
    await _open(
      tester,
      _Backend(),
      onChatGpt: (_) async {
        calls++;
        return true;
      },
    );
    expect(find.text('用账号登录 · 不用填 Key'), findsOneWidget);
    expect(find.text('用 Plus / Pro 套餐的额度'), findsOneWidget);
    await tester.tap(_key('provider.chatgpt'));
    await tester.pumpAndSettle();
    expect(calls, 1);
    // A signed-in account closes the page.
    expect(find.byType(ProviderSetupPage), findsNothing);
  });

  testWidgets('the key can be shown and hidden', (tester) async {
    await _open(tester, _Backend());
    bool obscured() =>
        tester.widget<TextField>(_key('provider.key')).obscureText;
    expect(obscured(), isTrue);
    await tester.tap(_key('provider.key.toggle'));
    await tester.pump();
    expect(obscured(), isFalse);
    expect(find.text('隐藏'), findsOneWidget);
    await tester.tap(_key('provider.key.toggle'));
    await tester.pump();
    expect(obscured(), isTrue);
  });

  testWidgets(
    'Test and save lists, probes the best candidate and saves it, key included',
    (tester) async {
      final backend = _Backend()
        ..lister = (_) => ModelListOk([
          _m('other-model', tools: true),
          _m('deepseek-chat'),
          _m('deepseek-v3.1'),
        ]);
      await _open(tester, backend);
      await _chip(tester, 'deepseek');
      expect(_enabled(tester), isFalse);
      await _type(tester, 'provider.key', ' sk-deep ');
      expect(_enabled(tester), isTrue);
      await _test(tester);
      expect(backend.listCalls.single.endpoint, 'https://api.deepseek.com');
      expect(backend.listCalls.single.newKey, 'sk-deep');
      expect(backend.probeCalls.map((i) => i.model), ['deepseek-v3.1']);
      expect(backend.saves, hasLength(1));
      final saved = backend.saves.single;
      expect(saved.providerId, 'deepseek');
      expect(saved.endpoint, 'https://api.deepseek.com');
      expect(saved.model, 'deepseek-v3.1');
      expect(saved.newKey, 'sk-deep');
      expect(saved.protocol, ModelProtocol.chatCompletions);
      expect(backend.credentialSaves, isEmpty);
      // A clean pass closes the page.
      expect(find.byType(ProviderSetupPage), findsNothing);
    },
  );

  testWidgets(
    'switching provider clears a typed key and swaps the model hint',
    (tester) async {
      await _open(tester, _Backend());
      await _type(tester, 'provider.key', 'old-provider-key');
      await _chip(tester, 'deepseek');
      expect(
        tester.widget<TextField>(_key('provider.key')).controller!.text,
        '',
      );
      expect(find.text('阿里云百炼 (Qwen)'), findsOneWidget);
    },
  );

  testWidgets(
    'a rejected first model is reported and the next one becomes the model',
    (tester) async {
      final backend = _Backend()
        ..lister = ((_) => ModelListOk([_m('deepseek-v4'), _m('deepseek-v3')]))
        ..prober = (input) => input.model == 'deepseek-v4'
            ? const ProbeNoToolCall()
            : const ProbeToolCalled();
      await _open(tester, backend);
      await _chip(tester, 'deepseek');
      await _type(tester, 'provider.key', 'sk');
      await _test(tester);
      expect(backend.probeCalls.map((i) => i.model), [
        'deepseek-v4',
        'deepseek-v3',
      ]);
      expect(backend.saves.single.model, 'deepseek-v3');
      // The note explains the fallback, so the page stays.
      expect(find.byType(ProviderSetupPage), findsOneWidget);
      expect(find.textContaining('deepseek-v4 没测试通过'), findsOneWidget);
      expect(find.textContaining('主模型用了测试通过的「deepseek-v3」'), findsOneWidget);
      expect(find.byKey(const ValueKey('provider.saved.id-0')), findsOneWidget);
    },
  );

  testWidgets('no model passing keeps the key but selects nothing', (
    tester,
  ) async {
    final backend = _Backend()
      ..lister = ((_) => ModelListOk([_m('deepseek-a'), _m('deepseek-b')]))
      ..prober = ((_) => const ProbeNoToolCall());
    await _open(tester, backend);
    await _chip(tester, 'deepseek');
    await _type(tester, 'provider.key', 'sk');
    await _test(tester);
    expect(backend.saves, isEmpty);
    expect(backend.credentialSaves.single.newKey, 'sk');
    expect(find.textContaining('服务商已连上'), findsOneWidget);
    expect(
      find.textContaining('试了 deepseek-a、deepseek-b，都没测试通过'),
      findsOneWidget,
    );
  });

  testWidgets('a rejected key blocks the save and names the reason', (
    tester,
  ) async {
    final backend = _Backend()
      ..lister = ((_) => ModelListOk([_m('deepseek-a')]))
      ..prober = (_) => ProbeFailed(
        const ModelRequestFailure('model_http_401', status: 401, body: '{}'),
      );
    await _open(tester, backend);
    await _chip(tester, 'deepseek');
    await _type(tester, 'provider.key', 'bad');
    await _test(tester);
    expect(backend.saves, isEmpty);
    expect(backend.credentialSaves, isEmpty);
    expect(_key('provider.failed'), findsOneWidget);
    expect(find.textContaining('API Key 无效或没有权限'), findsOneWidget);
    expect(_enabled(tester), isTrue);
  });

  testWidgets('a failing list reports why and opens the model name field', (
    tester,
  ) async {
    final backend = _Backend()
      ..lister = ((_) => const ModelListFailed(ListFailure.auth, status: 401));
    await _open(tester, backend);
    await _chip(tester, 'deepseek');
    await _type(tester, 'provider.key', 'bad');
    await _test(tester);
    expect(find.textContaining('连接失败：API Key 无效或没有权限'), findsOneWidget);
    expect(backend.probeCalls, isEmpty);
    expect(_key('provider.model'), findsOneWidget);
  });

  testWidgets('a typed model name is tried alone even if listing fails', (
    tester,
  ) async {
    final backend = _Backend()
      ..lister = ((_) =>
          const ModelListFailed(ListFailure.server, status: 500));
    await _open(tester, backend);
    await _chip(tester, 'deepseek');
    await _type(tester, 'provider.key', 'sk');
    await tester.tap(_key('provider.manual'));
    await tester.pump();
    expect(find.text('不填模型名'), findsOneWidget);
    expect(_key('provider.manualNote'), findsOneWidget);
    await _type(tester, 'provider.model', 'my-model');
    await _test(tester);
    expect(backend.probeCalls.map((i) => i.model), ['my-model']);
    expect(backend.saves.single.model, 'my-model');
    expect(backend.saves.single.newKey, 'sk');
  });

  testWidgets(
    'a typed model without tools keeps the provider but not the model',
    (tester) async {
      final backend = _Backend()..prober = ((_) => const ProbeNoToolCall());
      await _open(tester, backend);
      await _chip(tester, 'deepseek');
      await _type(tester, 'provider.key', 'sk');
      await tester.tap(_key('provider.manual'));
      await tester.pump();
      await _type(tester, 'provider.model', 'chatty');
      await _test(tester);
      expect(backend.saves, isEmpty);
      expect(backend.credentialSaves, hasLength(1));
      expect(find.textContaining('chatty 没有调用工具'), findsOneWidget);
    },
  );

  testWidgets('an empty list asks for a model name, then probes it', (
    tester,
  ) async {
    final backend = _Backend();
    await _open(tester, backend);
    await _chip(tester, 'ark');
    await _type(tester, 'provider.key', 'sk');
    await _test(tester);
    expect(backend.probeCalls, isEmpty);
    expect(_key('provider.noList'), findsOneWidget);
    expect(find.textContaining('这家没有列出模型'), findsOneWidget);
    expect(_key('provider.manual'), findsNothing);
    expect(_enabled(tester), isFalse);
    await _type(tester, 'provider.model', 'ep-123');
    expect(_enabled(tester), isTrue);
    await _test(tester);
    expect(backend.probeCalls.single.model, 'ep-123');
    expect(backend.saves.single.model, 'ep-123');
  });

  testWidgets('a probe failure for a missing model names the example', (
    tester,
  ) async {
    final backend = _Backend()
      ..prober = (_) => ProbeFailed(
        const ModelRequestFailure('model_not_found', status: 404, body: '{}'),
      );
    await _open(tester, backend);
    await _chip(tester, 'ark');
    await _type(tester, 'provider.key', 'sk');
    await _test(tester);
    await _type(tester, 'provider.model', 'nope');
    await _test(tester);
    expect(find.textContaining('模型「nope」不存在'), findsOneWidget);
    expect(backend.saves, isEmpty);
  });

  testWidgets('editing while a test runs discards its result', (tester) async {
    final gate = Completer<void>();
    final backend = _Backend()
      ..gate = gate.future
      ..lister = ((_) => ModelListOk([_m('deepseek-a')]));
    await _open(tester, backend);
    await _chip(tester, 'deepseek');
    await _type(tester, 'provider.key', 'first');
    await tester.tap(_key('provider.test'));
    await tester.pump();
    expect(find.text('正在测试…'), findsOneWidget);
    await _type(tester, 'provider.key', 'second');
    expect(find.text('测试并保存'), findsOneWidget);
    gate.complete();
    await tester.pumpAndSettle();
    expect(backend.probeCalls, isEmpty);
    expect(backend.saves, isEmpty);
    expect(find.byType(ProviderSetupPage), findsOneWidget);
    expect(
      tester.widget<TextField>(_key('provider.key')).controller!.text,
      'second',
    );
  });

  testWidgets('a saved key lets a blank key field test; custom shows the URL', (
    tester,
  ) async {
    final backend = _Backend(
      endpoint: 'https://model.example/v1/chat/completions',
      model: 'm',
      keyed: {'https://model.example/v1/chat/completions'},
    );
    await _open(tester, backend);
    expect(_key('provider.baseUrl'), findsOneWidget);
    expect(
      tester.widget<TextField>(_key('provider.baseUrl')).controller!.text,
      'https://model.example/v1/chat/completions',
    );
    expect(find.text('Chat Completions'), findsOneWidget);
    expect(find.text('Responses'), findsOneWidget);
    expect(_enabled(tester), isTrue);
    // A saved key belongs to its endpoint only.
    await _type(tester, 'provider.baseUrl', 'https://other.example/v1');
    expect(_enabled(tester), isFalse);
    await _type(tester, 'provider.baseUrl', 'other.example/v1');
    expect(find.text('接口地址要以 http:// 或 https:// 开头'), findsOneWidget);
    await _type(tester, 'provider.baseUrl', '');
    expect(_enabled(tester), isFalse);
  });

  testWidgets('editing a custom URL clears a typed key', (tester) async {
    await _open(
      tester,
      _Backend(endpoint: 'https://model.example/v1', model: 'm'),
    );
    await _type(tester, 'provider.key', 'typed-key');
    await _type(tester, 'provider.baseUrl', 'https://other.example/v1');
    expect(tester.widget<TextField>(_key('provider.key')).controller!.text, '');
  });

  testWidgets(
    'a configured provider opens the list and keeps the form closed',
    (tester) async {
      final backend = _Backend(
        saved: [
          const SavedProvider(
            id: 'x',
            endpoint: _openRouter,
            label: 'OpenRouter',
          ),
        ],
        keyed: {_openRouter},
      );
      await _open(tester, backend);
      expect(_key('provider.baseUrl'), findsNothing);
      expect(_key('provider.test'), findsNothing);
      expect(_key('provider.add'), findsOneWidget);
      await tester.tap(_key('provider.add'));
      await tester.pumpAndSettle();
      expect(_key('provider.test'), findsOneWidget);
      expect(_key('provider.add'), findsNothing);
      // The saved key counts for the preset the page opened on.
      expect(_enabled(tester), isTrue);
    },
  );

  testWidgets('an official address typed as custom suggests the preset', (
    tester,
  ) async {
    final backend = _Backend(endpoint: 'https://model.example/v1', model: 'm');
    await _open(tester, backend);
    expect(_key('provider.suggestion'), findsNothing);
    await _type(tester, 'provider.baseUrl', 'https://api.deepseek.com/v1');
    await _type(tester, 'provider.key', 'typed-key');
    expect(_key('provider.suggestion'), findsOneWidget);
    expect(find.textContaining('「DeepSeek」的官方地址'), findsOneWidget);
    await tester.tap(_key('provider.usePreset'));
    await tester.pumpAndSettle();
    expect(_key('provider.suggestion'), findsNothing);
    expect(_key('provider.baseUrl'), findsNothing);
    // The key typed so far is kept when switching to the preset.
    expect(
      tester.widget<TextField>(_key('provider.key')).controller!.text,
      'typed-key',
    );
  });

  testWidgets('self-hosted services need no key and explain the address', (
    tester,
  ) async {
    final backend = _Backend()..lister = ((_) => ModelListOk([_m('llama3')]));
    await _open(tester, backend);
    await _chip(tester, 'ollama');
    expect(_key('provider.selfHosted'), findsOneWidget);
    expect(find.textContaining('127.0.0.1 是这台手机自己'), findsOneWidget);
    expect(
      tester.widget<TextField>(_key('provider.baseUrl')).controller!.text,
      'http://127.0.0.1:11434/v1',
    );
    expect(find.text('本地服务可不填'), findsOneWidget);
    expect(_enabled(tester), isTrue);
    await _test(tester);
    expect(backend.saves.single.endpoint, 'http://127.0.0.1:11434/v1');
    expect(backend.saves.single.newKey, keylessServiceKey);
  });

  testWidgets('a plain-http network address is flagged and not testable', (
    tester,
  ) async {
    await _open(tester, _Backend());
    await _chip(tester, 'ollama');
    await _type(tester, 'provider.baseUrl', 'http://192.168.1.20:11434/v1');
    expect(_key('provider.unencrypted'), findsOneWidget);
    expect(find.textContaining('这个地址不加密'), findsOneWidget);
    expect(_enabled(tester), isFalse);
    await _type(tester, 'provider.baseUrl', 'https://models.lan/v1');
    expect(_key('provider.unencrypted'), findsNothing);
    await _type(tester, 'provider.key', 'k');
    expect(_enabled(tester), isTrue);
  });

  testWidgets('a custom loopback address may also go without a key', (
    tester,
  ) async {
    await _open(
      tester,
      _Backend(endpoint: 'http://localhost:8080/v1', model: 'm'),
    );
    expect(_enabled(tester), isTrue);
    await _type(tester, 'provider.baseUrl', 'https://remote.example/v1');
    expect(_enabled(tester), isFalse);
  });

  testWidgets('the credential manager link refreshes the saved list', (
    tester,
  ) async {
    final backend = _Backend();
    var opened = 0;
    await _open(
      tester,
      backend,
      onManageCredentials: (_) async {
        opened++;
        backend.saved.add(
          const SavedProvider(
            id: 'v',
            endpoint: 'https://api.groq.com/openai/v1',
            label: 'Groq',
          ),
        );
      },
    );
    expect(find.text('服务商'), findsNothing);
    await tester.tap(_key('model.credentials'));
    await tester.pumpAndSettle();
    expect(opened, 1);
    expect(find.byKey(const ValueKey('provider.saved.v')), findsOneWidget);
  });

  group('provider detail', () {
    _Backend withProviders({String? current}) {
      final backend =
          _Backend(
              endpoint: current ?? 'https://api.deepseek.com',
              model: 'deepseek-chat',
              saved: [
                const SavedProvider(
                  id: 'a',
                  endpoint: 'https://api.deepseek.com',
                  label: 'DeepSeek',
                ),
                const SavedProvider(
                  id: 'b',
                  endpoint: 'https://api.groq.com/openai/v1',
                  label: 'Groq',
                ),
              ],
              keyed: {
                'https://api.deepseek.com',
                'https://api.groq.com/openai/v1',
              },
            )
            ..lister = (input) => ModelListOk([
              const ListedModel(
                id: 'm-1',
                toolCalls: true,
                contextTokens: 131072,
                vision: true,
                reasoning: true,
              ),
              _m('m-2'),
              _m('m-3', tools: false),
              _m('m-4', tools: true),
              _m('m-5'),
            ]);
      return backend;
    }

    testWidgets('lists providers; detail shows status, address, key and tags', (
      tester,
    ) async {
      await _open(tester, withProviders());
      expect(find.text('DeepSeek'), findsOneWidget);
      expect(find.textContaining('正在使用 deepseek-chat'), findsOneWidget);
      expect(find.textContaining('api.groq.com/openai/v1'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('provider.saved.b')));
      await tester.pumpAndSettle();
      expect(find.byType(ProviderDetailPage), findsOneWidget);
      expect(find.text('已连接'), findsOneWidget);
      expect(find.text('api.groq.com/openai/v1'), findsOneWidget);
      expect(find.text('已保存 · 更换'), findsOneWidget);
      // Three previews, the rest behind "view all".
      expect(find.byKey(const ValueKey('provider.model.m-1')), findsOneWidget);
      // Models that can use tools are listed first; m-3 cannot.
      expect(find.byKey(const ValueKey('provider.model.m-4')), findsOneWidget);
      expect(find.byKey(const ValueKey('provider.model.m-3')), findsNothing);
      expect(find.text('查看全部 5 个'), findsOneWidget);
      // Capabilities the listing stated are plain; the rest say 未确认.
      expect(find.text('工具调用'), findsWidgets);
      expect(find.text('工具调用 · 未确认'), findsWidgets);
      expect(find.text('看图'), findsOneWidget);
      expect(find.text('推理'), findsOneWidget);
      expect(find.text('128K'), findsOneWidget);
      await tester.tap(_key('provider.viewAll'));
      await tester.pumpAndSettle();
      expect(find.text('Groq · 全部模型'), findsOneWidget);
      expect(find.byKey(const ValueKey('provider.model.m-5')), findsOneWidget);
      expect(find.text('不支持工具调用'), findsOneWidget);
    });

    testWidgets('a failing list shows the reason, a missing list explains', (
      tester,
    ) async {
      final backend = withProviders()
        ..lister = ((_) =>
            const ModelListFailed(ListFailure.auth, status: 401));
      await _open(tester, backend);
      await tester.tap(find.byKey(const ValueKey('provider.saved.b')));
      await tester.pumpAndSettle();
      expect(find.text('列模型失败'), findsOneWidget);
      expect(find.textContaining('API Key 无效或没有权限'), findsOneWidget);
      backend.lister = (_) =>
          const ModelListFailed(ListFailure.notSupported, status: 404);
      await tester.tap(find.text('刷新'));
      await tester.pumpAndSettle();
      expect(find.text('已连接'), findsOneWidget);
      expect(_key('provider.noListNote'), findsOneWidget);
    });

    testWidgets('using a listed model probes it first, then selects it', (
      tester,
    ) async {
      final backend = withProviders();
      await _open(tester, backend);
      await tester.tap(find.byKey(const ValueKey('provider.saved.b')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('provider.model.m-1')));
      await tester.pumpAndSettle();
      await tester.tap(_key('provider.model.use'));
      await tester.pumpAndSettle();
      expect(backend.probeCalls.single.model, 'm-1');
      expect(
        backend.probeCalls.single.endpoint,
        'https://api.groq.com/openai/v1',
      );
      expect(backend.saves.single.model, 'm-1');
      expect(find.text('正在使用'), findsOneWidget);

      backend.prober = (_) => const ProbeNoToolCall();
      await tester.tap(find.byKey(const ValueKey('provider.model.m-2')));
      await tester.pumpAndSettle();
      await tester.tap(_key('provider.model.use'));
      await tester.pumpAndSettle();
      expect(backend.saves, hasLength(1));
      expect(find.textContaining('m-2 没有调用工具'), findsOneWidget);
    });

    testWidgets('a custom Responses provider keeps its protocol', (
      tester,
    ) async {
      final backend = withProviders();
      backend.saved.add(
        const SavedProvider(
          id: 'c',
          endpoint: 'https://relay.example/v1',
          label: 'relay.example',
          protocol: ModelProtocol.responses,
        ),
      );
      await _open(tester, backend);
      await tester.tap(find.byKey(const ValueKey('provider.saved.c')));
      await tester.pumpAndSettle();
      expect(find.text('OpenAI Responses'), findsOneWidget);
      expect(backend.listCalls.last.protocol, ModelProtocol.responses);
      await tester.tap(find.byKey(const ValueKey('provider.model.m-1')));
      await tester.pumpAndSettle();
      await tester.tap(_key('provider.model.use'));
      await tester.pumpAndSettle();
      expect(backend.probeCalls.single.protocol, ModelProtocol.responses);
      expect(backend.saves.single.protocol, ModelProtocol.responses);
    });

    testWidgets('changing the key stores it without choosing a model', (
      tester,
    ) async {
      final backend = withProviders();
      await _open(tester, backend);
      await tester.tap(find.byKey(const ValueKey('provider.saved.b')));
      await tester.pumpAndSettle();
      await tester.tap(_key('provider.key.row'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextField>(_key('provider.newKey')).obscureText,
        isTrue,
      );
      await tester.enterText(_key('provider.newKey'), '  new-secret ');
      await tester.tap(_key('provider.newKey.save'));
      await tester.pumpAndSettle();
      expect(backend.credentialSaves.single.newKey, 'new-secret');
      expect(
        backend.credentialSaves.single.endpoint,
        'https://api.groq.com/openai/v1',
      );
      expect(backend.saves, isEmpty);
    });

    testWidgets('deleting asks first; the provider in use cannot be deleted', (
      tester,
    ) async {
      final backend = withProviders();
      await _open(tester, backend);
      // DeepSeek is the chat provider in use: delete is disabled and says why.
      await tester.tap(find.byKey(const ValueKey('provider.saved.a')));
      await tester.pumpAndSettle();
      expect(find.textContaining('先换成别的服务商再删除'), findsOneWidget);
      await tester.tap(_key('provider.delete'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      await tester.pageBack();
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('provider.saved.b')));
      await tester.pumpAndSettle();
      await tester.tap(_key('provider.delete'));
      await tester.pumpAndSettle();
      expect(find.text('删除「Groq」？'), findsOneWidget);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(backend.deleted, isEmpty);
      await tester.tap(_key('provider.delete'));
      await tester.pumpAndSettle();
      await tester.tap(_key('provider.delete.confirm'));
      await tester.pumpAndSettle();
      expect(backend.deleted, ['b']);
      expect(find.byType(ProviderDetailPage), findsNothing);
      expect(find.byKey(const ValueKey('provider.saved.b')), findsNothing);
    });

    testWidgets('a hand-typed model in use is listed and marked 手填', (
      tester,
    ) async {
      final backend = withProviders()..model = 'typed-model';
      await _open(tester, backend);
      await tester.tap(find.byKey(const ValueKey('provider.saved.a')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('provider.model.typed-model')),
        findsOneWidget,
      );
      expect(find.text('手填'), findsOneWidget);
    });
  });

  testWidgets('every part of the setup form fits a 360x780 phone', (
    tester,
  ) async {
    final backend = _Backend(
      endpoint: 'http://192.168.1.5:8080/v1',
      model: 'm',
      keyed: {'http://192.168.1.5:8080/v1'},
    )..lister = ((_) => const ModelListFailed(ListFailure.network));
    await _open(
      tester,
      backend,
      size: const Size(360, 780),
      onChatGpt: (_) async => false,
      onManageCredentials: (_) async {},
    );
    final list = find.byType(Scrollable).first;
    Future<void> reveal(String name, {double delta = 200}) async {
      await tester.scrollUntilVisible(_key(name), delta, scrollable: list);
      await tester.ensureVisible(_key(name));
      await tester.pumpAndSettle();
      final box = tester.getRect(_key(name));
      expect(box.left, greaterThanOrEqualTo(0), reason: name);
      expect(box.right, lessThanOrEqualTo(360), reason: name);
    }

    // A custom address: URL, protocol chips, key, manual model, warnings.
    await reveal('provider.chatgpt');
    await reveal('provider.baseUrl');
    await reveal('provider.key');
    await reveal('provider.unencrypted');
    await tester.tap(_key('provider.manual'));
    await tester.pumpAndSettle();
    await reveal('provider.manualNote');
    await reveal('provider.model');
    await reveal('provider.chip.custom', delta: -200);
    await reveal('provider.chip.lmstudio', delta: -200);
    await reveal('provider.manual');
    await reveal('provider.baseUrl', delta: -200);
    await _type(tester, 'provider.baseUrl', 'https://api.deepseek.com/v1');
    await _type(tester, 'provider.key', 'sk');
    await reveal('provider.suggestion');
    await reveal('provider.usePreset');
    await reveal('provider.test');
    await tester.tap(_key('provider.test'));
    await tester.pumpAndSettle();
    await reveal('provider.failed');
    await reveal('model.credentials');
    expect(tester.takeException(), isNull);
  });

  for (final language in ['zh', 'en']) {
    for (final width in [320.0, 360.0]) {
      testWidgets('setup and detail fit $width / $language / 2x text', (
        tester,
      ) async {
        final backend = _Backend(
          saved: [
            const SavedProvider(
              id: 'a',
              endpoint: 'https://api.deepseek.com',
              label: 'DeepSeek',
            ),
          ],
          keyed: {'https://api.deepseek.com'},
        )..lister = ((_) => ModelListOk([_m('deepseek-chat')]));
        await _open(
          tester,
          backend,
          language: language,
          size: Size(width, 740),
          textScale: 2,
          onChatGpt: (_) async => false,
        );
        final list = find.byType(Scrollable).first;
        Future<void> reveal(String name) async {
          await tester.scrollUntilVisible(_key(name), 200, scrollable: list);
          await tester.ensureVisible(_key(name));
          await tester.pumpAndSettle();
        }

        await reveal('provider.add');
        await tester.tap(_key('provider.add'));
        await tester.pumpAndSettle();
        await reveal('provider.test');
        expect(tester.takeException(), isNull);
        await tester.drag(list, const Offset(0, 4000));
        await tester.pumpAndSettle();
        await reveal('provider.saved.a');
        await tester.tap(_key('provider.saved.a'));
        await tester.pumpAndSettle();
        expect(find.byType(ProviderDetailPage), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  }
}
