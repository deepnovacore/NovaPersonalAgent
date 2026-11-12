import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/experience/persona.dart';
import 'package:nova_mobile/experience/persona_sources.dart';
import 'package:nova_mobile/ui/timeline_briefs.dart';
import 'experience_test.dart' show fixture;

Map<String, dynamic> richSnapshot(String version) => {
  'source_version': version,
  'profile': [
    {
      'title': 'Preference',
      'text': 'Tea',
      'refs': ['r0001'],
    },
  ],
  'timeline': [
    {
      'title': 'Review',
      'summary': 'Review tomorrow',
      'refs': ['r0002'],
      'time': {
        'kind': 'scheduled',
        'anchor_date': '2026-01-02',
        'anchor_basis': 'scheduled',
        'occurred_on': null,
        'started_on': null,
        'due_on': null,
        'scheduled_on': '2026-01-02',
        'last_reported_on': '2026-01-01',
        'evidence_from': '2026-01-01',
        'evidence_to': '2026-01-01',
        'as_of': '2026-01-01',
      },
      'temporal': {
        'kind': 'scheduled',
        'dates': [
          {
            'role': 'scheduled',
            'date': '2026-01-02',
            'ref': 'r0002',
            'quote': 'Sketch review tomorrow.',
          },
        ],
      },
      'kind': 'progress',
      'status_label': 'Scheduled',
      'people': [
        {'name': 'Sample', 'ref': 'r0002', 'quote': 'Sketch review tomorrow.'},
      ],
      'category': 'Design',
      'why_now': 'Review is next',
      'facts': [
        {
          'label': 'Plan',
          'tone': 'positive',
          'text': 'Sketch review',
          'ref': 'r0002',
          'quote': 'Sketch review tomorrow.',
        },
      ],
      'next_steps': [
        {'title': 'Prepare', 'detail': 'Bring the sketch'},
      ],
      'uncertainty': 'Time to confirm',
      'actions': [
        {'label': 'Discuss', 'kind': 'discuss'},
      ],
    },
  ],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late ExperiencePersonaSources sources;
  setUp(() async {
    final bundle = fixture();
    await ExperiencePersona.loadManifest(bundle: bundle);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMessageHandler('flutter/assets', (message) async {
          final bytes =
              bundle.files[utf8.decode(message!.buffer.asUint8List())];
          return bytes == null ? null : ByteData.sublistView(bytes);
        });
    sources = await ExperiencePersonaSources.load('sample');
  });
  tearDown(() {
    sources.snapshot.dispose();
    ExperiencePersona.choices = const [];
    rootBundle.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMessageHandler('flutter/assets', null);
  });

  test('rich snapshot preserves validated fields and legacy snapshots', () {
    final rich = richSnapshot(sources.version);
    expect(sources.validateSnapshot(rich), rich);
    final row = (rich['timeline'] as List).single as Map;
    for (final keepTime in [false, true]) {
      final legacy = {
        ...rich,
        'timeline': [
          {
            for (final key in [
              'title',
              'summary',
              'refs',
              if (keepTime) 'time',
            ])
              key: row[key],
          },
        ],
      };
      expect(sources.validateSnapshot(legacy), legacy);
    }
  });

  test(
    'rich snapshot rejects unknown fields, invalid types, dates and citations',
    () {
      final mutations = <void Function(Map)>[
        (r) => r['extra'] = true,
        (r) => r['summary'] = null,
        (r) => r['kind'] = 'unknown',
        (r) => r['status_label'] = 'x' * 19,
        (r) => r['category'] = '',
        (r) => r['why_now'] = 'x' * 161,
        (r) => r['uncertainty'] = false,
        (r) => r['people'] = {},
        (r) => r['people'][0]['name'] = '',
        (r) => r['people'][0]['extra'] = true,
        (r) => r['people'][0]['ref'] = 'r0001',
        (r) => r['facts'] = [],
        (r) => r['facts'][0]['tone'] = 'urgent',
        (r) => r['facts'][0]['quote'] = 'Invented quote',
        (r) => r['facts'][0]['text'] = 'x' * 161,
        (r) => r['next_steps'][0]['detail'] = false,
        (r) => r['actions'][0]['kind'] = 'execute',
        (r) => r['actions'][0]['url'] = 'https://example.com',
        (r) => r['temporal']['kind'] = 'invalid',
        (r) => r['temporal']['dates'][0]['date'] = '2026-02-30',
        (r) => r['temporal']['dates'][0]['role'] = 'invalid',
        (r) => r['temporal']['dates'][0]['ref'] = 'foreign',
        (r) => r['time']['as_of'] = '2026-02-30',
      ];
      for (final (index, mutate) in mutations.indexed) {
        final data =
            jsonDecode(jsonEncode(richSnapshot(sources.version)))
                as Map<String, dynamic>;
        mutate(data['timeline'][0] as Map);
        expect(
          () => sources.validateSnapshot(data),
          throwsFormatException,
          reason: 'mutation $index',
        );
      }
      final data =
          jsonDecode(jsonEncode(richSnapshot(sources.version)))
              as Map<String, dynamic>;
      data['profile'][0]['facts'] = [];
      expect(() => sources.validateSnapshot(data), throwsFormatException);
    },
  );

  testWidgets(
    'persona timeline projects rich facts and followups into shared cards',
    (tester) async {
      sources.snapshot.value = richSnapshot(sources.version);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: ExperiencePersonaTimeline(
                personaId: 'sample',
                sources: sources,
              ),
            ),
          ),
        ),
      );
      final row = sources.snapshot.value!['timeline'][0] as Map;
      final entry = tester
          .widget<TimelineBriefs>(find.byType(TimelineBriefs))
          .entries
          .single;
      for (final key in [
        'facts',
        'status_label',
        'people',
        'next_steps',
        'uncertainty',
        'actions',
      ]) {
        expect(entry['brief'][key], row[key], reason: key);
      }
      expect(entry['time'], row['time']);
      expect(entry['evidence_ids'], row['refs']);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );
}
