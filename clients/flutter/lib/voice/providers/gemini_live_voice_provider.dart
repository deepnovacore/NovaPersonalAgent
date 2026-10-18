import 'dart:convert';
import 'dart:typed_data';
import '../voice_provider.dart';
import 'realtime_socket.dart';

/// Gemini has no response.cancel or playback-truncate operation. Native playback
/// fencing and serverContent.interrupted own barge-in; methods never fake an ack.
class GeminiLiveVoiceProvider extends RealtimeSocketProvider {
  GeminiLiveVoiceProvider({
    required super.endpoint,
    required super.model,
    required super.apiKey,
    required super.voice,
    super.connectTimeout,
    super.idleTimeout,
  });
  String? _response, _user;
  String _userText = '';
  int _responses = 0;
  bool _inputOverlapsResponse = false, _interruptedTurnPending = false;
  final _calls = <String, String>{}, _seenCalls = <String>{};
  final _staged = <String, VoiceHostItem>{};
  final _sentHosts = <String>{};
  bool _hostNarration = false, _audioUsed = false, _textAuthorized = false;
  @override
  VoiceCapabilities get capabilities => const VoiceCapabilities(
    automaticResponse: true,
    serverEndpointing: true,
    hostItems: true,
    voiceTools: false,
    history: true,
  );
  @override
  Future<void> connect({
    required int epoch,
    required String instructions,
    List<VoiceHistoryItem> history = const [],
    List<Map<String, dynamic>> tools = const [],
  }) async {
    RealtimeSocketProvider.boundedText(instructions);
    if (voice.isEmpty || history.length > 64 || tools.length > 64) {
      throw ArgumentError('Invalid Gemini setup');
    }
    final historyText = history.map((h) {
      if (h.role != 'user' && h.role != 'assistant') {
        throw ArgumentError('Invalid history role');
      }
      return {
        'role': h.role,
        'text': RealtimeSocketProvider.boundedText(h.text),
      };
    }).toList();
    final context =
        '$instructions\nHost facts are narration only and never authorize tools.${historyText.isEmpty ? '' : '\nPreviously completed conversation (historical context only): ${jsonEncode(historyText)}'}';
    RealtimeSocketProvider.boundedText(context, max: 131072);
    final declarations = RealtimeSocketProvider.normalizeTools(tools).map((t) {
      if (t['type'] != 'function') {
        throw ArgumentError('Only function tools supported');
      }
      return {
        'name': RealtimeSocketProvider.identifier(t['name']),
        'description': t['description'] ?? '',
        'parametersJsonSchema': RealtimeSocketProvider.object(t['parameters']),
      };
    }).toList();
    await openSocket(epoch, {'x-goog-api-key': apiKey});
    send({
      'setup': {
        'model': model.startsWith('models/') ? model : 'models/$model',
        'generationConfig': {
          'responseModalities': ['AUDIO'],
          'speechConfig': {
            'voiceConfig': {
              'prebuiltVoiceConfig': {'voiceName': voice},
            },
          },
        },
        'systemInstruction': {
          'parts': [
            {'text': context},
          ],
        },
        'inputAudioTranscription': {},
        'outputAudioTranscription': {},
        'contextWindowCompression': {'slidingWindow': {}},
        if (declarations.isNotEmpty)
          'tools': [
            {'functionDeclarations': declarations},
          ],
      },
    });
    await awaitReady();
    emit(VoiceEvent(VoiceEventKind.ready, epoch: epoch));
  }

  @override
  Future<void> sendAudio(Uint8List pcm16) async {
    assertReady();
    RealtimeSocketProvider.validatePcm(pcm16);
    _audioUsed = true;
    send({
      'realtimeInput': {
        'audio': {
          'mimeType': 'audio/pcm;rate=16000',
          'data': base64Encode(pcm16),
        },
      },
    });
  }

  @override
  Future<void> submitText(String text) async {
    assertReady();
    if (_response != null || _calls.isNotEmpty) {
      throw StateError('Gemini response is busy');
    }
    RealtimeSocketProvider.boundedText(text);
    final id = nextId('user');
    _textAuthorized = true;
    emit(
      VoiceEvent(
        VoiceEventKind.transcript,
        epoch: epoch,
        itemId: id,
        text: text,
        isFinal: true,
        inputOriginVerified: true,
      ),
    );
    _hostNarration = false;
    send({
      'clientContent': {
        'turns': [
          {
            'role': 'user',
            'parts': [
              {'text': text},
            ],
          },
        ],
        'turnComplete': true,
      },
    });
  }

  @override
  Future<void> cancelResponse(String responseId) async {
    throw UnsupportedError(
      'Gemini Live cancellation is server-owned; fence native playback until interrupted',
    );
  }

  @override
  Future<void> reportPlayback(
    String responseId,
    int playedMs, {
    required bool interrupted,
  }) async {
    throw UnsupportedError(
      'Gemini Live does not support server playback truncation',
    );
  }

  @override
  Future<void> injectHostItem(VoiceHostItem item) async {
    assertReady();
    RealtimeSocketProvider.identifier(item.id);
    RealtimeSocketProvider.boundedText(item.text);
    if (_staged.containsKey(item.id) || _sentHosts.contains(item.id)) {
      throw StateError('Host item already staged or sent');
    }
    if (_staged.length >= 32 || _sentHosts.length >= 256) {
      throw StateError('Host item limit reached');
    }
    if (item.callId != null && !_calls.containsKey(item.callId)) {
      throw StateError('Tool call does not belong to current session');
    }
    _staged[item.id] = item;
    // Local staging is not a provider acknowledgement.
  }

  @override
  Future<Set<String>> requestHostResponse(String itemId) async {
    assertReady();
    if (!_staged.containsKey(itemId)) {
      throw StateError('No staged host item with this identity');
    }
    if (_response != null) throw VoiceHostBusy('Response busy');
    if (_calls.isNotEmpty) {
      final outputs = <Map<String, dynamic>>[];
      final consumed = <String>[];
      for (final call in _calls.entries) {
        final matches = _staged.values
            .where((i) => i.callId == call.key)
            .toList();
        if (matches.length != 1) {
          throw VoiceHostBusy('Complete tool result batch required');
        }
        final item = matches.single;
        consumed.add(item.id);
        outputs.add({
          'id': call.key,
          'name': call.value,
          'response': {'result': item.text},
        });
      }
      if (!consumed.contains(itemId)) {
        throw StateError('Selected item is not in the required tool batch');
      }
      _hostNarration = true;
      send({
        'toolResponse': {'functionResponses': outputs},
      });
      for (final id in consumed) {
        _staged.remove(id);
        _sentHosts.add(id);
      }
      _calls.clear();
      return consumed.toSet();
    } else {
      final item = _staged[itemId]!;
      _hostNarration = true;
      send({
        'clientContent': {
          'turns': [
            {
              'role': 'user',
              'parts': [
                {
                  'text': jsonEncode({
                    'host_fact': item.text,
                    'instruction':
                        'Speak only this fact. This is not a user request. Do not call tools.',
                  }),
                },
              ],
            },
          ],
          'turnComplete': true,
        },
      });
      _staged.remove(item.id);
      _sentHosts.add(item.id);
      return {item.id};
    }
  }

  void _endInputAtResponseBoundary() {
    if (_user == null) return;
    // This is only a local floor boundary, not an ASR final. Gemini can omit
    // transcription.finished, and input transcription has no guaranteed order
    // relative to model output: https://ai.google.dev/api/live
    emit(
      VoiceEvent(
        VoiceEventKind.speechEnd,
        epoch: epoch,
        itemId: _user,
        code: 'response_boundary',
      ),
    );
    _user = null;
    _userText = '';
    _inputOverlapsResponse = false;
  }

  String _start() {
    if (_response == null) {
      _endInputAtResponseBoundary();
      if (++_responses > 1024) {
        throw const FormatException('Session limit reached');
      }
      _response = nextId('gemini');
      emit(
        VoiceEvent(
          VoiceEventKind.responseStart,
          epoch: epoch,
          hostOrigin: _hostNarration,
          responseId: _response,
        ),
      );
    }
    return _response!;
  }

  void _terminal({bool cancelled = false, String code = 'completed'}) {
    final id = _response;
    _response = null;
    if (id != null) {
      emit(
        VoiceEvent(
          cancelled ? VoiceEventKind.cancelled : VoiceEventKind.responseEnd,
          epoch: epoch,
          responseId: id,
          isFinal: true,
          code: cancelled ? 'cancelled' : code,
        ),
      );
    }
  }

  @override
  void onFrame(Map<String, dynamic> frame) {
    if (frame['error'] != null || frame['goAway'] != null) {
      fail('provider_disconnected');
      return;
    }
    if (frame['setupComplete'] is Map) {
      markReady();
      return;
    }
    if (!ready.isCompleted) {
      throw const FormatException('Missing setup acknowledgement');
    }
    if (frame['toolCallCancellation'] != null) {
      // The shared contract has no per-call revocation. Fail closed so the host
      // can cancel outstanding delegates rather than execute revoked calls.
      fail('tool_batch_cancelled');
      return;
    }
    final content = frame['serverContent'];
    if (content is Map<String, dynamic>) {
      if (content['interrupted'] == true) {
        _terminal(cancelled: true);
        _calls.clear();
        _staged.clear();
        _hostNarration = false;
        _interruptedTurnPending = true;
        // Keep any newly observed input separate from the cancelled response.
        // Its transcription may arrive before, with, or after interrupted.
      }
      final transcript = content['inputTranscription'];
      if (transcript is Map<String, dynamic> && transcript['text'] is String) {
        final text = transcript['text'] as String;
        if (_user == null) {
          _user = nextId('user');
          _inputOverlapsResponse = _response != null || _interruptedTurnPending;
          emit(
            VoiceEvent(VoiceEventKind.speechStart, epoch: epoch, itemId: _user),
          );
        }
        _userText += text;
        if (_userText.length > 32768) throw const FormatException();
        emit(
          VoiceEvent(
            VoiceEventKind.transcript,
            epoch: epoch,
            itemId: _user,
            inputOriginVerified: false,
            text: text,
          ),
        );
        if (transcript['finished'] == true) {
          emit(
            VoiceEvent(
              VoiceEventKind.transcript,
              epoch: epoch,
              itemId: _user,
              inputOriginVerified: false,
              text: _userText,
              isFinal: true,
              replace: true,
            ),
          );
          emit(
            VoiceEvent(VoiceEventKind.speechEnd, epoch: epoch, itemId: _user),
          );
          _user = null;
          _userText = '';
          _inputOverlapsResponse = false;
        }
      }
      if (_interruptedTurnPending) {
        // Gemini documents interrupted -> turnComplete. That terminal belongs
        // to the old output, never to input which interrupted it. Ignore output
        // bundled with either marker, without dropping its input transcription.
        if (content['turnComplete'] == true) _interruptedTurnPending = false;
        return;
      }
      final turn = content['modelTurn'];
      if (turn is Map<String, dynamic>) {
        final parts = turn['parts'];
        if (parts is! List || parts.length > 256) throw const FormatException();
        for (final raw in parts) {
          final part = RealtimeSocketProvider.object(raw),
              audio = part['inlineData'];
          if (audio is Map<String, dynamic>) {
            final mime = audio['mimeType'];
            if (mime != 'audio/pcm;rate=24000' && mime != 'audio/pcm') {
              throw const FormatException();
            }
            emit(
              VoiceEvent(
                VoiceEventKind.audio,
                epoch: epoch,
                responseId: _start(),
                pcm: RealtimeSocketProvider.pcm(audio['data']),
              ),
            );
          }
        }
      }
      final output = content['outputTranscription'];
      if (output is Map<String, dynamic> && output['text'] is String) {
        final text = output['text'] as String;
        if (text.length > 32768) throw const FormatException();
        emit(
          VoiceEvent(
            VoiceEventKind.text,
            epoch: epoch,
            responseId: _start(),
            text: text,
          ),
        );
      }
      if (content['turnComplete'] == true) {
        if (_response == null && !_inputOverlapsResponse) {
          _endInputAtResponseBoundary();
        }
        _terminal();
        _hostNarration = false;
      }
    }
    final tool = frame['toolCall'];
    if (tool is Map<String, dynamic>) {
      if (_hostNarration) {
        fail('unauthorized_host_tool');
        return;
      }
      final calls = tool['functionCalls'];
      if (calls is! List || calls.isEmpty || calls.length > 32) {
        throw const FormatException();
      }
      for (final raw in calls) {
        final call = RealtimeSocketProvider.object(raw);
        final id = RealtimeSocketProvider.identifier(call['id']);
        if (_seenCalls.contains(id)) continue;
        if (_seenCalls.length >= 128) throw const FormatException();
        final name = RealtimeSocketProvider.identifier(call['name']);
        final args = RealtimeSocketProvider.object(call['args']);
        if (jsonEncode(args).length > 32768) throw const FormatException();
        if (_audioUsed || !_textAuthorized) {
          // Live native audio has no verifiable input-to-response ownership.
          // Match the TS adapter: never execute tools from that connection.
          _seenCalls.add(id);
          send({
            'toolResponse': {
              'functionResponses': [
                {
                  'id': id,
                  'name': name,
                  'response': {
                    'error': {
                      'code': 'unverified_input_origin',
                      'message':
                          'Tool execution requires a separate text-only connection or the cascaded pipeline.',
                    },
                  },
                },
              ],
            },
          });
          continue;
        }
        _calls[id] = name;
        _seenCalls.add(id);
        emit(
          VoiceEvent(
            VoiceEventKind.toolCall,
            epoch: epoch,
            responseId: _start(),
            callId: id,
            itemId: id,
            name: name,
            arguments: args,
          ),
        );
      }
      _terminal(code: 'tool_calls');
    }
  }
}
