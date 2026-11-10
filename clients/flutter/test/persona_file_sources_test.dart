import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/experience/persona.dart';
import 'package:nova_mobile/experience/persona_sources.dart';
import 'experience_test.dart' show fixture;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final kind in ['file', 'unsupported']) {
    test(
      'persona source kind $kind preserves validation and file metadata',
      () async {
        final bundle = fixture();
        const base = 'assets/experience/';
        final source = {
          'records': [
            {
              'id': 'r0001',
              'kind': kind,
              'locator': 'synthetic://sample/document',
              'observed_at': '2026-01-01T02:00:00Z',
              'text': 'I prefer tea.',
              'metadata': {
                'file_name': 'notes.md',
                'doc_type': 'markdown',
                'version': 'v2',
              },
            },
            {
              'id': 'r0002',
              'kind': 'calendar',
              'locator': 'synthetic://sample/review',
              'observed_at': '2026-01-01T03:00:00Z',
              'text': 'Review the notes.',
            },
          ],
        };
        bundle.json('${base}sample.sources.json', source);
        final version = sha256
            .convert(bundle.files['${base}sample.sources.json']!)
            .toString();
        final snapshot =
            jsonDecode(
                  utf8.decode(bundle.files['${base}sample.snapshot.json']!),
                )
                as Map;
        bundle.json('${base}sample.snapshot.json', {
          ...snapshot,
          'source_version': version,
        });
        final manifest =
            jsonDecode(utf8.decode(bundle.files['${base}manifest.json']!))
                as Map;
        final hashes = manifest['personas'][0]['sha256'] as Map;
        hashes['sources'] = version;
        hashes['snapshot'] = sha256
            .convert(bundle.files['${base}sample.snapshot.json']!)
            .toString();
        bundle.json('${base}manifest.json', manifest);
        await ExperiencePersona.loadManifest(bundle: bundle);
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        messenger.setMockMessageHandler('flutter/assets', (message) async {
          final bytes =
              bundle.files[utf8.decode(message!.buffer.asUint8List())];
          return bytes == null ? null : ByteData.sublistView(bytes);
        });
        addTearDown(() {
          messenger.setMockMessageHandler('flutter/assets', null);
          ExperiencePersona.choices = const [];
          rootBundle.clear();
        });
        if (kind == 'unsupported') {
          await expectLater(
            ExperiencePersonaSources.load('sample'),
            throwsFormatException,
          );
          return;
        }
        final sources = await ExperiencePersonaSources.load('sample');
        addTearDown(sources.snapshot.dispose);
        await sources.restoreSnapshot(null);
        expect(sources.snapshot.value!['source_version'], version);
        final record =
            (sources.read({'offset': 0, 'query': 'tea'})['records'] as List)
                    .single
                as Map;
        expect(record['kind'], 'file');
        expect(record['text'], 'I prefer tea.');
        expect(record['file_name'], 'notes.md');
        expect(record['doc_type'], 'markdown');
        expect(record['version'], 'v2');
      },
    );
  }
}
