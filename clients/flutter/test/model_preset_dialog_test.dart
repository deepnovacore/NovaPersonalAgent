import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/ui/theme.dart';

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

Future<void> _open(WidgetTester tester, _Models models) async {
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
    (_) async => null,
  );
  await tester.pumpWidget(
    MaterialApp(
      theme: novaTheme(),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showLocalModelSettings(context, models),
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
  testWidgets('a new user sees a preset form: key only, no URL field', (
    tester,
  ) async {
    final models = _Models(null);
    await _open(tester, models);
    expect(find.byType(TextField), findsNWidgets(2)); // key + model
    expect(find.text('接口地址'), findsNothing);
    await tester.enterText(find.widgetWithText(TextField, 'API 密钥'), 'sk-1');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(models.last, {
      'endpoint': 'https://openrouter.ai/api/v1',
      'model': 'openai/gpt-4.1-mini',
      'key': 'sk-1',
      'protocol': ModelProtocol.chatCompletions,
    });
  });

  testWidgets('choosing another preset swaps endpoint and recommended model', (
    tester,
  ) async {
    final models = _Models(null);
    await _open(tester, models);
    await tester.tap(find.text('OpenRouter'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('DeepSeek').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'API 密钥'), 'sk-2');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(models.last?['endpoint'], 'https://api.deepseek.com');
    expect(models.last?['model'], 'deepseek-chat');
    expect(models.last?['key'], 'sk-2');
  });

  testWidgets('custom keeps the free-form fields and a blank key', (
    tester,
  ) async {
    final models = _Models(
      ModelConfiguration(
        endpoint: 'https://model.example/v1/chat/completions',
        model: 'm',
        key: 'saved',
      ),
    );
    await _open(tester, models);
    expect(find.text('接口地址'), findsOneWidget);
    expect(find.text('自定义（OpenAI 兼容）'), findsOneWidget);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(
      models.last?['endpoint'],
      'https://model.example/v1/chat/completions',
    );
    expect(models.last?['key'], '');
  });

  testWidgets('a saved preset endpoint reopens on that preset unchanged', (
    tester,
  ) async {
    final models = _Models(
      ModelConfiguration(
        endpoint: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-reasoner',
        key: 'saved',
      ),
    );
    await _open(tester, models);
    expect(find.text('DeepSeek'), findsOneWidget);
    expect(find.text('接口地址'), findsNothing);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    // Endpoint text is preserved so the stored key is still retained.
    expect(
      models.last?['endpoint'],
      'https://api.deepseek.com/chat/completions',
    );
    expect(models.last?['model'], 'deepseek-reasoner');
  });
  testWidgets('switching provider clears an explicitly entered key', (
    tester,
  ) async {
    final models = _Models(null);
    await _open(tester, models);
    await tester.enterText(
      find.widgetWithText(TextField, 'API 密钥'),
      'old-provider-key',
    );
    await tester.tap(find.text('OpenRouter'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('DeepSeek').last);
    await tester.pumpAndSettle();
    expect(_keyText(tester), isEmpty);
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(models.last?['key'], isEmpty);
  });

  testWidgets(
    'editing a custom URL clears typed key and prevents saved key reuse',
    (tester) async {
      final http = _installModelHttp();
      await _open(tester, _customModels());
      await tester.enterText(
        find.widgetWithText(TextField, 'API 密钥'),
        'typed-key',
      );
      await tester.enterText(
        find.widgetWithText(TextField, '接口地址'),
        'https://other.example/v1',
      );
      await tester.pump();
      expect(_keyText(tester), isEmpty);
      await _load(tester);
      expect(http.requests, isEmpty);
      expect(find.text('请先填写有效的接口地址和密钥。'), findsOneWidget);
    },
  );

  testWidgets(
    'loading models reuses a saved key only at the unchanged endpoint',
    (tester) async {
      final http = _installModelHttp();
      await _open(tester, _customModels());
      await _load(tester);
      expect(
        http.requests.single.headers.values['Authorization'],
        'Bearer saved-key',
      );
      http.requests.single.complete(['public-model']);
      await tester.pumpAndSettle();
      expect(find.text('已加载 1 个模型。'), findsOneWidget);
    },
  );

  for (final ids in [
    <String>[],
    ['public-model'],
  ]) {
    testWidgets(
      'a public model list does not claim a key is valid (${ids.length} models)',
      (tester) async {
        final http = _installModelHttp();
        await _open(tester, _Models(null));
        await tester.enterText(
          find.widgetWithText(TextField, 'API 密钥'),
          'invalid-key',
        );
        await _load(tester);
        http.requests.single.complete(ids);
        await tester.pumpAndSettle();
        expect(find.text('获取模型列表'), findsOneWidget);
        expect(
          find.text(ids.isEmpty ? '该厂商没有返回模型列表，请直接填写模型名。' : '已加载 1 个模型。'),
          findsOneWidget,
        );
        expect(find.textContaining('验证通过'), findsNothing);
        expect(find.textContaining('密钥可用'), findsNothing);
      },
    );
  }

  for (final status in [200, 401]) {
    testWidgets('changing key discards an older model result ($status)', (
      tester,
    ) async {
      final http = _installModelHttp();
      await _open(tester, _Models(null));
      await tester.enterText(
        find.widgetWithText(TextField, 'API 密钥'),
        'first-key',
      );
      await _load(tester);
      await tester.enterText(
        find.widgetWithText(TextField, 'API 密钥'),
        'second-key',
      );
      await tester.pump();
      expect(
        tester.widget<OutlinedButton>(find.byType(OutlinedButton)).onPressed,
        isNotNull,
      );
      await _load(tester);
      expect(http.requests, hasLength(2));
      http.requests.last.complete(['current-model']);
      await tester.pumpAndSettle();
      http.requests.first.complete([
        'stale-model',
        'another-stale-model',
      ], status: status);
      await tester.pumpAndSettle();
      expect(find.text('已加载 1 个模型。'), findsOneWidget);
      final picker = tester.widget<DropdownButton<String>>(
        find.byWidgetPredicate(
          (widget) =>
              widget is DropdownButton<String> &&
              widget.items!.any((item) => item.value == 'current-model'),
        ),
      );
      expect(picker.items!.map((item) => item.value), ['current-model']);
      expect(find.text('stale-model'), findsNothing);
      expect(find.textContaining('密钥被拒绝'), findsNothing);
    });
  }

  testWidgets('changing a custom URL discards its in-flight model list', (
    tester,
  ) async {
    final http = _installModelHttp();
    await _open(tester, _customModels());
    await _load(tester);
    await tester.enterText(
      find.widgetWithText(TextField, '接口地址'),
      'https://other.example/v1',
    );
    await tester.pump();
    http.requests.single.complete(['stale-model']);
    await tester.pumpAndSettle();
    expect(find.text('从列表选择模型'), findsNothing);
    expect(find.text('stale-model'), findsNothing);
    expect(find.text('获取模型列表'), findsOneWidget);
    await _load(tester);
    expect(http.requests, hasLength(1));
    expect(find.text('请先填写有效的接口地址和密钥。'), findsOneWidget);
  });
}

_Models _customModels() => _Models(
  ModelConfiguration(
    endpoint: 'https://model.example/v1',
    model: 'm',
    key: 'saved-key',
  ),
);

String _keyText(WidgetTester tester) => tester
    .widget<TextField>(find.widgetWithText(TextField, 'API 密钥'))
    .controller!
    .text;

Future<void> _load(WidgetTester tester) async {
  await tester.ensureVisible(find.byType(OutlinedButton));
  await tester.tap(find.byType(OutlinedButton));
  await tester.pump();
}

_ModelHttp _installModelHttp() {
  final previous = HttpOverrides.current;
  final http = _ModelHttp();
  HttpOverrides.global = http;
  addTearDown(() => HttpOverrides.global = previous);
  return http;
}

class _ModelHttp extends HttpOverrides {
  final requests = <_ModelRequest>[];
  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      _ModelClient(requests);
}

class _ModelClient implements HttpClient {
  _ModelClient(this.requests);
  final List<_ModelRequest> requests;
  @override
  Duration? connectionTimeout;
  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    final request = _ModelRequest();
    requests.add(request);
    return request;
  }

  @override
  void close({bool force = false}) {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _ModelRequest implements HttpClientRequest {
  final response = Completer<HttpClientResponse>();
  @override
  final _ModelHeaders headers = _ModelHeaders();
  @override
  bool followRedirects = true;
  void complete(List<String> ids, {int status = 200}) => response.complete(
    _ModelResponse(
      status,
      jsonEncode({
        'data': [
          for (final id in ids) {'id': id},
        ],
      }),
    ),
  );
  @override
  Future<HttpClientResponse> close() => response.future;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _ModelHeaders implements HttpHeaders {
  final values = <String, Object>{};
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {
    values[name] = value;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _ModelResponse extends Stream<List<int>> implements HttpClientResponse {
  _ModelResponse(this.statusCode, this.body);
  @override
  final int statusCode;
  final String body;
  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream.value(utf8.encode(body)).listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
