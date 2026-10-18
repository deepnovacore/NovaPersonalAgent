import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/voice/phone_voice_session.dart';
import 'package:nova_mobile/voice/voice_provider.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'phone_voice_session_test.dart'
    show TestVoiceProvider, VoiceAudio, settle;

/// Replays the provider/audio projection of the TS session fixtures unchanged.
/// TS host-delivery policy/state snapshots are not asserted by this projection.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final name in [
    'barge-in-late-delta',
    'started-while-user-speaking',
    'duplicate-response-terminal',
    'transcript-final-authority',
  ]) {
    test('shared TS provider/media trace: $name', () async {
      final fixture = Directory(
        '../../tests/fixtures/realtime/session/v1/$name',
      );
      final input =
          jsonDecode(File('${fixture.path}/input.json').readAsStringSync())
              as Map;
      final expected =
          jsonDecode(File('${fixture.path}/expected.json').readAsStringSync())
              as Map;
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final conversation = await store.create();
      final audio = VoiceAudio(), provider = TestVoiceProvider();
      final session = PhoneVoiceSession(
        audio: audio,
        requestMicrophone: () async => true,
        store: store,
      );
      try {
        var stepIndex = 0;
        for (final step in input['steps'] as List) {
          final beforeReply = session.reply;
          switch (step['kind']) {
            case 'connect':
              await session.start(
                provider: provider,
                conversation: conversation,
              );
            case 'deliver_host_response':
              // Fixture host ownership precedes the provider/media projection.
              // No claims about the full TS host-delivery snapshot are made here.
              break;
            case 'provider_event':
              final event = step['event'] as Map;
              final kind = switch (event['kind']) {
                'response_started' => VoiceEventKind.responseStart,
                'response_audio_delta' => VoiceEventKind.audio,
                'response_transcript_final' => VoiceEventKind.text,
                'user_speech_started' => VoiceEventKind.speechStart,
                'user_speech_ended' => VoiceEventKind.speechEnd,
                'response_terminal' =>
                  event['status'] == 'cancelled'
                      ? VoiceEventKind.cancelled
                      : VoiceEventKind.responseEnd,
                _ => throw StateError(
                  'Unmapped fixture event ${event['kind']}',
                ),
              };
              provider.controller.add(
                VoiceEvent(
                  kind,
                  epoch: event['session_epoch'] as int,
                  responseId: event['response_id'] as String?,
                  itemId: event['provider_item_id'] as String?,
                  text: event['text'] as String?,
                  isFinal: kind == VoiceEventKind.text,
                  replace: kind == VoiceEventKind.text,
                  pcm: event['pcm'] == null
                      ? null
                      : base64Decode(event['pcm']['pcm_base64'] as String),
                ),
              );
            case 'local_speech_onset':
              audio.controller.add({
                'kind': 'control',
                'generation': audio.generation,
                'control': {'type': 'speech.onset'},
              });
            case 'playback_started':
            case 'playback_cleared':
            case 'playback_done':
            case 'complete_playback':
              if (audio.frames.isNotEmpty) {
                final identity = audio.frames.last.identity;
                audio.controller.add({
                  'kind': 'control',
                  'generation': audio.generation,
                  'control': {
                    ...identity.fields,
                    'type': switch (step['kind']) {
                      'playback_started' => 'playback.started',
                      'playback_cleared' => 'playback.cleared',
                      _ => 'playback.done',
                    },
                    if (step['played_ms'] != null)
                      'played_ms': step['played_ms'],
                  },
                });
              }
            default:
              throw StateError('Unmapped fixture step ${step['kind']}');
          }
          await settle();
          final observation =
              (expected['observations'] as List)[stepIndex++] as Map;
          if (step['event']?['kind'] == 'response_transcript_final' &&
              observation['result'] == false) {
            expect(
              session.reply,
              beforeReply,
              reason: 'Rejected/fenced final must not replace visible response',
            );
          }
        }
        final observations = expected['observations'] as List;
        final expectedFrames = observations
            .expand((e) => e['frames'] as List)
            .toList();
        expect(
          audio.frames.map((e) => base64Encode(e.pcm)).toList(),
          expectedFrames.map((e) => e['pcm_base64']).toList(),
        );
        final expectedCancels = observations
            .expand((e) => e['actions'] as List)
            .whereType<String>()
            .where((e) => e.startsWith('cancel:'))
            .map((e) => e.substring(7))
            .toList();
        for (final cancel in expectedCancels) {
          expect(provider.cancels.where((e) => e == cancel), hasLength(1));
        }
        if (name == 'transcript-final-authority') {
          final accepted = <String>[];
          final steps = input['steps'] as List;
          for (final observation in observations) {
            final step = steps[observation['step'] as int] as Map;
            if (observation['result'] == true &&
                step['event']?['kind'] == 'response_transcript_final') {
              accepted.add(step['event']['text'] as String);
            }
          }
          final saved = (store.conversation(conversation)['messages'] as List)
              .where((m) => m['role'] == 'assistant')
              .map((m) => m['content'])
              .toList();
          expect(saved, accepted);
        }
      } finally {
        await session.stop();
        session.dispose();
        await provider.controller.close();
        await audio.controller.close();
      }
    });
  }
}
