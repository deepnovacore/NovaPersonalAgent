import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/web_fetch.dart';

void main() {
  test('rejects non-public addresses including IPv6 tunnels', () {
    for (final address in [
      '0.0.0.0', '10.0.0.1', '100.100.100.200', '127.0.0.1',
      '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.0.1',
      '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
      '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1',
      'fe80::1', '::ffff:127.0.0.1', '64:ff9b::a00:1',
      '2001::1', '2001:db8::1', '2002:7f00:1::1', 'ff02::1',
    ]) {
      expect(SafeWebFetch.isPublicAddress(InternetAddress(address)), false,
          reason: address);
    }
    for (final address in ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(SafeWebFetch.isPublicAddress(InternetAddress(address)), true);
    }
  });

  test('rejects unsafe URL forms before DNS', () async {
    final fetcher = SafeWebFetch(lookup: (_) async => throw StateError('DNS'));
    for (final url in ['http://example.com', 'https://u:p@example.com',
      'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'file:///tmp/a']) {
      await expectLater(fetcher.fetch(url), throwsA(isA<FormatException>()));
    }
  });

  test('rejects a DNS set containing any private address', () async {
    final fetcher = SafeWebFetch(lookup: (_) async => [
      InternetAddress('8.8.8.8'), InternetAddress('10.0.0.1'),
    ]);
    await expectLater(fetcher.fetch('https://example.com'),
        throwsA(isA<FormatException>()));
  });

  test('DNS lookup is covered by total timeout', () async {
    final fetcher = SafeWebFetch(
      timeout: const Duration(milliseconds: 10),
      lookup: (_) => Completer<List<InternetAddress>>().future,
    );
    await expectLater(fetcher.fetch('https://example.com'),
        throwsA(isA<TimeoutException>()));
  });
}
