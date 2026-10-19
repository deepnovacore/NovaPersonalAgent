import 'dart:convert';
import 'dart:io';
import 'local_life.dart';

final class HttpLifeSync implements LifeSyncTransport {
  HttpLifeSync(String endpoint, this.token) : base = Uri.parse(endpoint) {
    if (base.scheme != 'https' &&
        !(base.scheme == 'http' &&
            ['127.0.0.1', 'localhost', '::1'].contains(base.host))) {
      throw const FormatException('Hub requires HTTPS');
    }
    if (base.userInfo.isNotEmpty ||
        base.query.isNotEmpty ||
        base.fragment.isNotEmpty ||
        base.host.isEmpty) {
      throw const FormatException('Invalid Hub address');
    }
  }
  final Uri base;
  final String token;
  @override
  Future<Map<String, dynamic>> snapshot() async =>
      Map<String, dynamic>.from(await request('GET', 'state') as Map);
  @override
  Future<Map<String, dynamic>> push(Map<String, dynamic> command) => request(
    'POST',
    'mutations',
    command,
  ).then((value) => Map<String, dynamic>.from(value as Map));
  Future<dynamic> request(String method, String path, [Object? body]) async {
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10);
    try {
      return await (() async {
        final relative = Uri.parse(path);
        final url = base.replace(
          path:
              '${base.path.replaceFirst(RegExp(r'/$'), '')}/hub/v1/${relative.path}',
          query: relative.hasQuery ? relative.query : null,
        );
        final request = await client
            .openUrl(method, url)
            .timeout(const Duration(seconds: 15));
        request.followRedirects = false;
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        if (body != null) {
          request.headers.contentType = ContentType.json;
          request.write(jsonEncode(body));
        }
        final response = await request.close().timeout(
          const Duration(seconds: 15),
        );
        final bytes = <int>[];
        await for (final chunk in response.timeout(
          const Duration(seconds: 15),
        )) {
          bytes.addAll(chunk);
          if (bytes.length > 16 * 1024 * 1024) {
            throw const FormatException('Hub response too large');
          }
        }
        final value = jsonDecode(utf8.decode(bytes));
        if ([400, 409].contains(response.statusCode) &&
            value is Map &&
            value['snapshot'] is Map) {
          throw LifeSyncConflict(
            value['error'] as String,
            Map<String, dynamic>.from(value['snapshot']),
          );
        }
        if (response.statusCode != 200) {
          throw HttpException(
            'Hub: ${value is Map ? value['error'] : response.statusCode}',
          );
        }
        return value;
      })().timeout(const Duration(seconds: 30));
    } finally {
      client.close(force: true);
    }
  }
}
