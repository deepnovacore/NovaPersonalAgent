import 'dart:convert';
import 'dart:io';
import 'dart:async';

class FeishuFailure implements Exception {
  const FeishuFailure(this.code);
  final String code;
  @override
  String toString() => 'Feishu: $code';
}

class FeishuResponse {
  const FeishuResponse(this.status, this.data);
  final int status;
  final Map<String, dynamic> data;
}

typedef FeishuTransport =
    Future<FeishuResponse> Function(
      String method,
      Uri uri,
      Map<String, String> headers,
      String? body,
    );

/// Direct official endpoints only. No redirects, arbitrary URLs or body logging.
class FeishuApi {
  FeishuApi({FeishuTransport? transport}) : transport = transport ?? _http;
  final FeishuTransport transport;
  String accounts(String brand) => brand == 'feishu'
      ? 'accounts.feishu.cn'
      : brand == 'lark'
      ? 'accounts.larksuite.com'
      : throw const FeishuFailure('invalid_brand');
  String openHost(String brand) => brand == 'feishu'
      ? 'open.feishu.cn'
      : brand == 'lark'
      ? 'open.larksuite.com'
      : throw const FeishuFailure('invalid_brand');
  Uri verificationUri(String brand, String text) {
    final uri = Uri.tryParse(text);
    if (uri == null ||
        uri.scheme != 'https' ||
        ![accounts(brand), openHost(brand)].contains(uri.host) ||
        uri.userInfo.isNotEmpty ||
        uri.port != 443 ||
        uri.fragment.isNotEmpty) {
      throw const FeishuFailure('invalid_verification_url');
    }
    return uri;
  }

  Future<FeishuResponse> oauth(
    String brand,
    String path,
    Map<String, String> form, {
    String? basic,
  }) {
    if (![
      '/oauth/v1/device_authorization',
      '/oauth/v3/token',
      '/oauth/v1/revoke',
      '/oauth/v1/app/registration',
    ].contains(path)) {
      throw const FeishuFailure('invalid_auth_operation');
    }
    return transport('POST', Uri.https(accounts(brand), path), {
      'content-type': 'application/x-www-form-urlencoded',
      if (basic != null) 'authorization': 'Basic $basic',
    }, Uri(queryParameters: form).query);
  }

  Future<Map<String, dynamic>> get(
    String brand,
    String path,
    String token, {
    Map<String, String>? query,
  }) async {
    if (![
      '/open-apis/authen/v1/user_info',
      '/open-apis/im/v1/chats',
      '/open-apis/im/v1/messages',
    ].contains(path)) {
      throw const FeishuFailure('unsupported_resource');
    }
    final result = await transport(
      'GET',
      Uri.https(openHost(brand), path, query),
      {'authorization': 'Bearer $token'},
      null,
    );
    if (result.status != 200 ||
        result.data['code'] != 0 ||
        result.data['data'] is! Map) {
      throw FeishuFailure(
        result.status == 429 ? 'rate_limited' : 'resource_unavailable',
      );
    }
    return Map<String, dynamic>.from(result.data['data'] as Map);
  }

  static Future<FeishuResponse> _http(
    String method,
    Uri uri,
    Map<String, String> headers,
    String? body,
  ) async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 15);
    try {
      return await (() async {
        final request = await client.openUrl(method, uri);
        request.followRedirects = false;
        headers.forEach(request.headers.set);
        if (body != null) request.write(body);
        final response = await request.close();
        final bytes = <int>[];
        await for (final chunk in response) {
          bytes.addAll(chunk);
          if (bytes.length > 2 * 1024 * 1024) {
            throw const FeishuFailure('response_too_large');
          }
        }
        if (response.statusCode >= 300 && response.statusCode < 400) {
          throw const FeishuFailure('redirect_refused');
        }
        final value = bytes.isEmpty
            ? <String, dynamic>{}
            : jsonDecode(utf8.decode(bytes));
        if (value is! Map<String, dynamic>) {
          throw const FeishuFailure('invalid_response');
        }
        return FeishuResponse(response.statusCode, value);
      })().timeout(const Duration(seconds: 30));
    } on FeishuFailure {
      rethrow;
    } on TimeoutException {
      throw const FeishuFailure('network_timeout');
    } on HandshakeException {
      throw const FeishuFailure('network_tls_failed');
    } on SocketException {
      throw const FeishuFailure('network_unreachable');
    } on FormatException {
      throw const FeishuFailure('invalid_response');
    } on HttpException {
      throw const FeishuFailure('http_transport_failed');
    } catch (_) {
      throw const FeishuFailure('network_or_response_error');
    } finally {
      client.close(force: true);
    }
  }
}
