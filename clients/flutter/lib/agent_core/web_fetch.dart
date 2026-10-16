import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Reads public HTTPS content as data, never as instructions or authority.
class SafeWebFetch {
  SafeWebFetch({
    Future<List<InternetAddress>> Function(String)? lookup,
    this.timeout = const Duration(seconds: 15),
    this.maxBytes = 1024 * 1024,
  }) : _lookup = lookup ?? InternetAddress.lookup;

  final Future<List<InternetAddress>> Function(String) _lookup;
  final Duration timeout;
  final int maxBytes;

  static bool isPublicAddress(InternetAddress address) {
    final b = address.rawAddress;
    if (address.type == InternetAddressType.IPv4) {
      return !(b[0] == 0 ||
          b[0] == 10 ||
          b[0] == 127 ||
          b[0] >= 224 ||
          (b[0] == 100 && b[1] >= 64 && b[1] <= 127) ||
          (b[0] == 169 && b[1] == 254) ||
          (b[0] == 172 && b[1] >= 16 && b[1] <= 31) ||
          (b[0] == 192 &&
              (b[1] == 168 ||
                  (b[1] == 0 && (b[2] == 0 || b[2] == 2)) ||
                  (b[1] == 88 && b[2] == 99))) ||
          (b[0] == 198 &&
              (b[1] == 18 || b[1] == 19 || (b[1] == 51 && b[2] == 100))) ||
          (b[0] == 203 && b[1] == 0 && b[2] == 113));
    }
    // Only native global unicast; exclude special-use, documentation and tunnels.
    return (b[0] & 0xe0) == 0x20 &&
        !(b[0] == 0x20 && b[1] == 0x01 && b[2] < 2) &&
        !(b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0d && b[3] == 0xb8) &&
        !(b[0] == 0x20 && b[1] == 0x02) &&
        !(b[0] == 0x3f && b[1] == 0xff && (b[2] & 0xf0) == 0);
  }

  static Uri _validateUrl(String url) {
    final uri = Uri.parse(url);
    final host = uri.host.replaceAll('[', '').replaceAll(']', '');
    final literal = InternetAddress.tryParse(host);
    if (uri.scheme != 'https' ||
        host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        host == 'localhost' ||
        host.endsWith('.localhost') ||
        (literal != null && !isPublicAddress(literal))) {
      throw const FormatException('web_fetch_unsafe_url');
    }
    return uri;
  }

  Future<Map<String, dynamic>> fetch(String url) async {
    final initial = _validateUrl(url);
    final client = HttpClient()
      ..connectionTimeout = timeout
      ..findProxy = ((_) => 'DIRECT');
    var finished = false;
    try {
      return await (() async {
        final host = initial.host.replaceAll('[', '').replaceAll(']', '');
        final literal = InternetAddress.tryParse(host);
        final addresses = literal == null ? await _lookup(host) : [literal];
        if (finished) throw TimeoutException('web_fetch_timeout');
        if (addresses.isEmpty || !addresses.every(isPublicAddress)) {
          throw const FormatException('web_fetch_unsafe_address');
        }
        // Connect to the validated IP, but retain the URL host for TLS validation.
        client.connectionFactory = (uri, proxyHost, proxyPort) {
          if (finished || uri.origin != initial.origin || proxyHost != null) {
            throw const FormatException('web_fetch_unsafe_connection');
          }
          return Socket.startConnect(addresses.first, uri.port);
        };
        var uri = initial;
        for (var redirects = 0; ; redirects++) {
          if (finished) throw TimeoutException('web_fetch_timeout');
          final request = await client.getUrl(uri);
          request.followRedirects = false;
          request.cookies.clear();
          final response = await request.close();
          if ([301, 302, 303, 307, 308].contains(response.statusCode)) {
            final location = response.headers.value(HttpHeaders.locationHeader);
            if (redirects >= 3 || location == null) {
              throw const FormatException('web_fetch_redirect_limit');
            }
            final target = _validateUrl(uri.resolve(location).toString());
            if (target.origin != initial.origin) {
              throw const FormatException('web_fetch_cross_origin_redirect');
            }
            await response.listen((_) {}).cancel();
            uri = target;
            continue;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            throw HttpException('web_fetch_http_${response.statusCode}');
          }
          if (response.contentLength > maxBytes) {
            throw const FormatException('web_fetch_too_large');
          }
          final bytes = <int>[];
          await for (final chunk in response) {
            if (bytes.length + chunk.length > maxBytes) {
              throw const FormatException('web_fetch_too_large');
            }
            bytes.addAll(chunk);
          }
          return <String, dynamic>{
            'url': uri.toString(),
            'content': utf8.decode(bytes, allowMalformed: true),
            'untrusted': true,
          };
        }
      })().timeout(timeout);
    } finally {
      finished = true;
      client.close(force: true);
    }
  }
}
