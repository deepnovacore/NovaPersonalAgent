import 'dart:convert';
import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/chatgpt_accounts.dart';
import 'package:nova_mobile/agent_core/chatgpt_identity.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent/local_agent.dart';

Map<String, dynamic> registration({int expiry = 1}) => {
  'client_id': 'oaiapp_test',
  'subject': 'subject',
  'email': 'account@example.test',
  'access_token': 'old-access',
  'refresh_token': 'rotating-refresh',
  'id_token': 'old-id',
  'expires_at': expiry,
  'scopes': ['chatgpt.tokens.use.direct'],
  'model': 'model-slug',
};

class SwitchingNative implements LocalAgent {
  @override
  Future<dynamic> call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    if (method == 'saveModelSettings') {
      const storage = FlutterSecureStorage();
      final data =
          jsonDecode((await storage.read(key: ChatGptAccounts.storageKey))!)
              as Map;
      data['active'] = 'other';
      (data['accounts'] as List).add({
        ...registration(
          expiry: DateTime.now().millisecondsSinceEpoch + 3600000,
        ),
        'client_id': 'other',
      });
      await storage.write(
        key: ChatGptAccounts.storageKey,
        value: jsonEncode(data),
      );
    }
    return {};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(
    () => FlutterSecureStorage.setMockInitialValues({
      ChatGptAccounts.storageKey: jsonEncode({
        'host_id': 'urn:uuid:fixture',
        'active': 'oaiapp_test',
        'accounts': [registration()],
      }),
    }),
  );
  test(
    'callback binds state and returning client; denial and duplicates fail',
    () {
      Uri callback(String query) =>
          Uri.parse('http://127.0.0.1:1234/auth/callback?$query');
      expect(
        validateChatGptCallback(
          callback('state=s&code=c&client_id=issued'),
          's',
          null,
        ),
        'issued',
      );
      expect(
        validateChatGptCallback(callback('state=s&code=c'), 's', 'issued'),
        'issued',
      );
      for (final query in [
        'state=wrong&code=c',
        'state=s&code=c&client_id=other',
        'state=s&error=access_denied',
        'state=s&code=c&code=d',
        'state=s&code=c&client_id=dynamic_agent_client',
      ]) {
        expect(
          () => validateChatGptCallback(callback(query), 's', 'issued'),
          throwsA(isA<AgentFailure>()),
        );
      }
      expect(
        () => validateChatGptCallback(callback('state=s&code=c'), 's', null),
        throwsA(isA<AgentFailure>()),
      );
    },
  );
  test(
    'signed identity rejects signature, issuer, audience, expiry, nonce and subject mismatches',
    () {
      final fixture =
          jsonDecode(
                File('test/fixtures/chatgpt-identity.json').readAsStringSync(),
              )
              as Map;
      Map<String, dynamic> verify(
        String token, {
        String audience = 'oaiapp_test',
        String nonce = 'nonce',
        String subject = 'subject',
      }) => verifyChatGptIdentity(
        token,
        Map<String, dynamic>.from(fixture['jwks'] as Map),
        clientId: audience,
        nonce: nonce,
        subject: subject,
        now: DateTime.utc(2026),
      );
      expect(verify(fixture['valid'] as String)['sub'], 'subject');
      for (final key in ['wrongIssuer', 'wrongSubject', 'expired']) {
        expect(
          () => verify(fixture[key] as String),
          throwsA(isA<AgentFailure>()),
        );
      }
      expect(
        () => verify(fixture['valid'] as String, audience: 'other'),
        throwsA(isA<AgentFailure>()),
      );
      expect(
        () => verify(fixture['valid'] as String, nonce: 'other'),
        throwsA(isA<AgentFailure>()),
      );
      final pieces = (fixture['valid'] as String).split('.');
      pieces[1] = base64Url
          .encode(utf8.encode('{"sub":"forged"}'))
          .replaceAll('=', '');
      expect(() => verify(pieces.join('.')), throwsA(isA<AgentFailure>()));
    },
  );
  test(
    'refresh is serialized across instances and rotates tokens atomically',
    () async {
      var calls = 0;
      Future<Map<String, dynamic>> request(
        Uri uri, {
        Map<String, String>? form,
        String? bearer,
      }) async {
        calls++;
        expect(form, {
          'grant_type': 'refresh_token',
          'client_id': 'oaiapp_test',
          'refresh_token': 'rotating-refresh',
          'resource': chatGptResource,
        });
        await Future<void>.delayed(const Duration(milliseconds: 10));
        return {
          'access_token': 'new-access',
          'refresh_token': 'new-refresh',
          'token_type': 'Bearer',
          'expires_in': 3600,
        };
      }

      final a = ChatGptAccounts(request: request),
          b = ChatGptAccounts(request: request);
      final result = await Future.wait([
        a.credentials(),
        b.credentials(),
        a.credentials(),
      ]);
      expect(calls, 1);
      expect(
        result.every(
          (r) =>
              r['access_token'] == 'new-access' &&
              r['refresh_token'] == 'new-refresh',
        ),
        isTrue,
      );
      final metadata = await a.metadata();
      expect(jsonEncode(metadata), isNot(contains('new-access')));
      expect(jsonEncode(metadata), isNot(contains('refresh_token')));
    },
  );
  test(
    'temporary refresh failure keeps tokens; terminal grant clears only tokens',
    () async {
      final temporary = ChatGptAccounts(
        request: (uri, {form, bearer}) async {
          throw const AgentFailure('chatgpt_network_unavailable');
        },
      );
      await expectLater(temporary.credentials(), throwsA(isA<AgentFailure>()));
      expect((await temporary.active())!['refresh_token'], 'rotating-refresh');
      final terminal = ChatGptAccounts(
        request: (uri, {form, bearer}) async {
          throw const AgentFailure('invalid_grant');
        },
      );
      await expectLater(terminal.credentials(), throwsA(isA<AgentFailure>()));
      expect((await terminal.active())!['refresh_token'], isNull);
      expect((await terminal.active())!['client_id'], 'oaiapp_test');
      expect((await terminal.read())['host_id'], 'urn:uuid:fixture');
    },
  );
  test(
    'catalog uses official models array and account token in server order',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        ChatGptAccounts.storageKey: jsonEncode({
          'active': 'oaiapp_test',
          'accounts': [
            registration(
              expiry: DateTime.now().millisecondsSinceEpoch + 3600000,
            ),
          ],
        }),
      });
      final service = ChatGptAccounts(
        request: (uri, {form, bearer}) async {
          expect(uri.toString(), '$chatGptResource/models');
          expect(bearer, 'old-access');
          return {
            'models': [
              {
                'visibility': 'hidden',
                'slug': 'hidden',
                'display_name': 'Hidden',
              },
              {
                'visibility': 'list',
                'slug': 'second',
                'display_name': 'Second',
              },
              {'visibility': 'list', 'slug': 'first', 'display_name': 'First'},
            ],
          };
        },
      );
      expect((await service.models()).map((m) => m['slug']), [
        'second',
        'first',
      ]);
    },
  );
  test('plan-disabled grants never list models or infer', () async {
    final account = registration(
      expiry: DateTime.now().millisecondsSinceEpoch + 3600000,
    )..['scopes'] = ['openid'];
    FlutterSecureStorage.setMockInitialValues({
      ChatGptAccounts.storageKey: jsonEncode({
        'active': 'oaiapp_test',
        'accounts': [account],
      }),
    });
    final service = ChatGptAccounts(
      request: (uri, {form, bearer}) async {
        fail('network must not be reached');
      },
    );
    await expectLater(
      service.models(),
      throwsA(
        isA<AgentFailure>().having(
          (f) => f.code,
          'code',
          'chatgpt_plan_disabled',
        ),
      ),
    );
  });
  test('logout uses discovered revocation and retains registration', () async {
    final service = ChatGptAccounts(
      request: (uri, {form, bearer}) async {
        if (form == null) {
          return {
            'issuer': 'https://auth.openai.com',
            'revocation_endpoint': 'https://auth.openai.com/revoke',
          };
        }
        expect(form, {
          'token': 'rotating-refresh',
          'token_type_hint': 'refresh_token',
          'client_id': 'oaiapp_test',
        });
        return {};
      },
    );
    expect(await service.signOut('oaiapp_test'), isTrue);
    expect((await service.active())!['id_token'], isNull);
    expect((await service.active())!['subject'], 'subject');
  });
  test(
    'failed remote logout clears locally and reports lack of confirmation',
    () async {
      final service = ChatGptAccounts(
        request: (uri, {form, bearer}) async {
          throw const AgentFailure('chatgpt_network_unavailable');
        },
      );
      expect(await service.signOut('oaiapp_test'), isFalse);
      expect((await service.active())!['access_token'], isNull);
    },
  );
  test(
    'selected ChatGPT registration never falls back to saved paid API key',
    () async {
      const storage = FlutterSecureStorage();
      await storage.write(
        key: ModelSettings.storageKey,
        value: jsonEncode({
          'endpoint': 'https://paid.example/v1',
          'model': 'paid',
          'key': 'paid-key',
        }),
      );
      final account = registration(
        expiry: DateTime.now().millisecondsSinceEpoch + 3600000,
      )..remove('model');
      await storage.write(
        key: ChatGptAccounts.storageKey,
        value: jsonEncode({
          'active': 'oaiapp_test',
          'accounts': [account],
        }),
      );
      final settings = ModelSettings();
      await expectLater(
        settings.read(),
        throwsA(
          isA<AgentFailure>().having(
            (f) => f.code,
            'code',
            'chatgpt_model_required',
          ),
        ),
      );
      account.remove('access_token');
      await storage.write(
        key: ChatGptAccounts.storageKey,
        value: jsonEncode({
          'active': 'oaiapp_test',
          'accounts': [account],
        }),
      );
      await expectLater(
        settings.read(),
        throwsA(
          isA<AgentFailure>().having(
            (f) => f.code,
            'code',
            'chatgpt_sign_in_required',
          ),
        ),
      );
      expect((await settings.readApiKey())!.model, 'paid');
    },
  );
  test(
    'account switch during native projection rejects stale credentials',
    () async {
      const storage = FlutterSecureStorage();
      await storage.write(
        key: ChatGptAccounts.storageKey,
        value: jsonEncode({
          'active': 'oaiapp_test',
          'accounts': [
            registration(
              expiry: DateTime.now().millisecondsSinceEpoch + 3600000,
            ),
          ],
        }),
      );
      await expectLater(
        ModelSettings(native: SwitchingNative()).read(),
        throwsA(
          isA<AgentFailure>().having(
            (f) => f.code,
            'code',
            'chatgpt_account_changed',
          ),
        ),
      );
    },
  );
  test(
    'headless reasoning reads valid OAuth credentials without native channel or writes',
    () async {
      const storage = FlutterSecureStorage();
      final original = jsonEncode({
        'active': 'oaiapp_test',
        'accounts': [
          registration(expiry: DateTime.now().millisecondsSinceEpoch + 3600000),
        ],
      });
      await storage.write(key: ChatGptAccounts.storageKey, value: original);
      final config = await ModelSettings(headless: true).read();
      expect(config!.protocol, ModelProtocol.chatgptResponses);
      expect(config.key, 'old-access');
      expect(await storage.read(key: ChatGptAccounts.storageKey), original);
    },
  );
  test(
    'headless expiry requires foreground refresh without rotating credentials',
    () async {
      const storage = FlutterSecureStorage();
      final original = await storage.read(key: ChatGptAccounts.storageKey);
      await expectLater(
        ModelSettings(headless: true).read(),
        throwsA(
          isA<AgentFailure>().having(
            (f) => f.code,
            'code',
            'chatgpt_foreground_refresh_required',
          ),
        ),
      );
      expect(await storage.read(key: ChatGptAccounts.storageKey), original);
    },
  );
  test(
    'ChatGPT protocol preserves context, namespaces tools and omits unsupported fields',
    () {
      final config = ModelConfiguration(
        endpoint: chatGptResource,
        model: 'slug',
        key: 'test',
        protocol: ModelProtocol.chatgptResponses,
      );
      final body = modelRequestBody(
        config,
        [
          {'role': 'system', 'content': 'instructions'},
          {'role': 'user', 'content': 'hello'},
        ],
        [
          {
            'type': 'function',
            'function': {
              'name': 'local_tool',
              'parameters': {'type': 'object'},
            },
          },
        ],
      );
      expect(config.requestUri.toString(), '$chatGptResource/responses');
      expect(body['store'], false);
      expect(body['stream'], true);
      expect((body['input'] as List).first['role'], 'developer');
      expect((body['tools'] as List).single['type'], 'namespace');
      for (final key in [
        'temperature',
        'max_tokens',
        'max_output_tokens',
        'previous_response_id',
        'conversation',
        'background',
        'metadata',
      ]) {
        expect(body.containsKey(key), false);
      }
      expect(
        () => ModelConfiguration(
          endpoint: 'https://other.example',
          model: 'slug',
          key: 'test',
          protocol: ModelProtocol.chatgptResponses,
        ),
        throwsA(isA<AgentFailure>()),
      );
    },
  );
  test(
    'Responses success requires terminal completed, failed and incomplete throw',
    () {
      final stream = ResponsesStream();
      expect(
        stream.add({'type': 'response.output_text.delta', 'delta': 'partial'}),
        {'content': 'partial'},
      );
      expect(stream.finished, false);
      expect(
        () => stream.add({
          'type': 'response.failed',
          'response': {
            'error': {'code': 'subscription_sharing_usage_limit_exceeded'},
          },
        }),
        throwsA(
          isA<AgentFailure>().having(
            (f) => f.code,
            'code',
            'subscription_sharing_usage_limit_exceeded',
          ),
        ),
      );
      expect(
        () => ResponsesStream().add({
          'type': 'response.incomplete',
          'response': {},
        }),
        throwsA(isA<AgentFailure>()),
      );
      stream.add({
        'type': 'response.completed',
        'response': {'status': 'completed'},
      });
      expect(stream.finished, true);
    },
  );
}
