import 'package:nova_mobile/context/profile_writer.dart';

// Existing profile/repair tests focus on their original behavior. Adapt their
// simulated model responses to the new independent Timeline protocol; direct
// protocol and grounding tests use ProfileWriter itself without this adapter.
ProfileWriter fixtureProfileWriter({
  required ProfileCompletion complete,
  void Function(String)? onProgress,
  Future<List<Map<String, dynamic>>?> Function(List<Map<String, dynamic>>)?
  loadValidatedBatch,
  Future<void> Function(List<Map<String, dynamic>>, List<Map<String, dynamic>>)?
  saveValidatedBatch,
}) => ProfileWriter(
  onProgress: onProgress,
  loadValidatedBatch: loadValidatedBatch,
  saveValidatedBatch: saveValidatedBatch,
  complete: (stage, instructions, input) async {
    if (stage == 'timeline_select') {
      return {
        'topics': [
          for (final observation in input['observations'] as List)
            if ((observation['text'] as String).startsWith('【事】'))
              {
                'observation_indices': [observation['index']],
              },
        ],
      };
    }
    final result = await complete(stage, instructions, input);
    final messages = input['messages'];
    if (messages is List && ['draft', 'edit', 'repair'].contains(stage)) {
      final originals = {
        for (final message in messages) message['evidence_id']: message,
      };
      final rows = result['timeline'] ?? result['entries'];
      if (rows is List) {
        for (final row in rows) {
          if (row is! Map ||
              row.containsKey('brief') ||
              row.containsKey('kind') && row['kind'] != 'timeline' ||
              row['text'] is! String) {
            continue;
          }
          final refs = row['evidence_ids'];
          if (refs is! List || refs.isEmpty) continue;
          final ref = refs.first, original = originals[refs.first];
          final quote = original is Map && original['text'] is String
              ? original['text'] as String
              : 'missing original';
          row['brief'] = {
            'title': row['text'],
            'status_label': '',
            'facts': [
              {
                'text': row['text'],
                'ref': ref,
                'quote': quote.length > 100 ? quote.substring(0, 100) : quote,
              },
            ],
            'why_now': '这一进展回应了本人提出的项目计划。',
            'next_steps': <Object>[],
            'uncertainty': '',
          };
        }
      }
    }
    return result;
  },
);
