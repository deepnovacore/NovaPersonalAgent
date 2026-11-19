import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/local_news.dart';

void main() {
  test(
    'generated publicNewsSources exactly matches the shared runtime JSON',
    () {
      final shared = jsonDecode(
        File('../../runtime/src/news/sources.json').readAsStringSync(),
      );
      expect(
        publicNewsSources
            .map(
              (s) => {
                'id': s.id,
                'name': s.name,
                'url': s.url,
                'language': s.language,
              },
            )
            .toList(),
        shared,
      );
      expect(
        publicNewsSources.map((s) => s.id).toSet().length,
        publicNewsSources.length,
      );
    },
  );
}
