import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'ports.dart';

const maxVolcFrameBytes = 10 * 1024 * 1024;
const maxVolcJsonBytes = 1024 * 1024;
const _sessionEvents = {
  100,
  101,
  102,
  150,
  151,
  152,
  153,
  200,
  350,
  351,
  352,
  359,
};
const _connectionResponses = {50, 51, 52};
const _events = {1, 2, ..._sessionEvents, ..._connectionResponses};
Never _invalid() => throw const CascadeFailure('invalid_volc_frame');

/// Binary V1 event framing shared with runtime/realtime/volcengine/protocol.ts.
class VolcFrame {
  VolcFrame({
    required this.type,
    this.event,
    this.sessionId,
    this.connectId,
    this.sequence,
    this.errorCode,
    required this.payload,
  });
  final int type;
  final int? event, sequence, errorCode;
  final String? sessionId, connectId;
  final Uint8List payload;
  Uint8List encode() {
    if (!{1, 9, 11}.contains(type) || !_events.contains(event)) _invalid();
    final writer = BytesBuilder();
    void integer(int value) =>
        writer.add((ByteData(4)..setInt32(0, value)).buffer.asUint8List());
    void sized(List<int> bytes) {
      integer(bytes.length);
      writer.add(bytes);
    }

    integer(event!);
    if (_sessionEvents.contains(event)) {
      if (sessionId == null || sessionId!.isEmpty || sessionId!.length > 256) {
        _invalid();
      }
      sized(utf8.encode(sessionId!));
    } else if (_connectionResponses.contains(event) && type != 1) {
      sized(utf8.encode(connectId ?? ''));
    }
    sized(payload);
    if (writer.length + 4 > maxVolcFrameBytes) _invalid();
    return Uint8List.fromList([
      0x11,
      (type << 4) | 4,
      type == 1 ? 0x10 : 0,
      0,
      ...writer.takeBytes(),
    ]);
  }

  static VolcFrame decode(List<int> raw) {
    if (raw.length < 8 || raw.length > maxVolcFrameBytes || raw[0] >> 4 != 1) {
      _invalid();
    }
    final bytes = Uint8List.fromList(raw),
        data = ByteData.sublistView(Uint8List.fromList(raw));
    var offset = (bytes[0] & 15) * 4;
    final flag = bytes[1] & 15, type = bytes[1] >> 4;
    // TTS is uncompressed raw audio / JSON. Reject unknown serialization/compression.
    if (offset < 4 ||
        offset > bytes.length ||
        flag > 4 ||
        !{1, 9, 11, 15}.contains(type) ||
        (bytes[2] & 15) != 0 ||
        bytes[2] >> 4 > 1) {
      _invalid();
    }
    int integer({bool signed = true}) {
      if (offset + 4 > bytes.length) _invalid();
      final value = signed ? data.getInt32(offset) : data.getUint32(offset);
      offset += 4;
      return value;
    }

    Uint8List sized() {
      final count = integer(signed: false);
      if (offset + count > bytes.length) _invalid();
      final value = Uint8List.sublistView(bytes, offset, offset + count);
      offset += count;
      return value;
    }

    String identifier() {
      final value = sized();
      if (value.length > 1024) _invalid();
      try {
        return utf8.decode(value);
      } catch (_) {
        return _invalid();
      }
    }

    int? error, sequence, event;
    String? session, connection;
    if (type == 15) {
      error = integer(signed: false);
    } else if (flag == 1 || flag == 3) {
      sequence = integer();
    }
    if (flag == 4) {
      event = integer();
      if (!_events.contains(event)) _invalid();
      if (_sessionEvents.contains(event)) {
        session = identifier();
      } else if (_connectionResponses.contains(event)) {
        connection = identifier();
      }
    }
    final payload = sized();
    if (offset != bytes.length) _invalid();
    return VolcFrame(
      type: type,
      event: event,
      sequence: sequence,
      errorCode: error,
      sessionId: session,
      connectId: connection,
      payload: payload,
    );
  }
}

Uint8List volcAsrRequest(String userId) => _asrOutbound(
  0x11,
  1,
  utf8.encode(
    jsonEncode({
      'user': {'uid': userId},
      'audio': {
        'format': 'pcm',
        'rate': 16000,
        'bits': 16,
        'channel': 1,
        'codec': 'raw',
      },
      'request': {
        'model_name': 'bigmodel',
        'enable_punc': true,
        'enable_itn': true,
        'show_utterances': true,
        'result_type': 'full',
      },
    }),
  ),
);
Uint8List volcAsrAudio(
  Uint8List audio,
  int sequence, {
  required bool finalFrame,
}) {
  if (audio.isEmpty ||
      audio.length.isOdd ||
      audio.length > 2080000 ||
      sequence < 1 ||
      sequence > 0x7fffffff) {
    _invalid();
  }
  return _asrOutbound(
    finalFrame ? 0x23 : 0x21,
    finalFrame ? -sequence : sequence,
    audio,
  );
}

Uint8List _asrOutbound(int flags, int sequence, List<int> plain) {
  final payload = gzip.encode(plain);
  if (payload.length + 12 > maxVolcFrameBytes) _invalid();
  final bytes = Uint8List(12 + payload.length);
  bytes.setAll(0, [0x11, flags, 0x11, 0]);
  final data = ByteData.sublistView(bytes);
  data.setInt32(4, sequence);
  data.setUint32(8, payload.length);
  bytes.setAll(12, payload);
  return bytes;
}

class _BoundedSink implements Sink<List<int>> {
  final bytes = BytesBuilder();
  @override
  void add(List<int> value) {
    if (bytes.length + value.length > maxVolcJsonBytes) _invalid();
    bytes.add(value);
  }

  @override
  void close() {}
}

CascadeTranscript? decodeVolcAsr(List<int> raw) {
  if (raw.length < 12 || raw.length > maxVolcFrameBytes || raw[0] != 0x11) {
    _invalid();
  }
  final type = raw[1] >> 4, flag = raw[1] & 15, compression = raw[2] & 15;
  if (type == 15) throw const CascadeFailure('volc_asr_failed');
  if (type != 9 ||
      !{1, 3}.contains(flag) ||
      !{0, 1}.contains(compression) ||
      raw[2] >> 4 != 1) {
    _invalid();
  }
  final data = ByteData.sublistView(Uint8List.fromList(raw));
  if (data.getUint32(8) != raw.length - 12) _invalid();
  final sink = _BoundedSink();
  try {
    if (compression == 1) {
      final decoder = gzip.decoder.startChunkedConversion(sink);
      // Bounded input slices also bound each inflater output allocation.
      for (var i = 12; i < raw.length; i += 1024) {
        decoder.add(
          raw.sublist(i, i + 1024 > raw.length ? raw.length : i + 1024),
        );
      }
      decoder.close();
    } else {
      sink.add(raw.sublist(12));
    }
    final outer = jsonDecode(utf8.decode(sink.bytes.takeBytes()));
    if (outer is! Map<String, dynamic>) _invalid();
    void checkCode(Map value) {
      if (![null, 0, '0', 20000000, '20000000'].contains(value['code'])) {
        throw const CascadeFailure('volc_asr_failed');
      }
    }

    checkCode(outer);
    dynamic nested = outer['payload_msg'];
    if (nested is String) nested = jsonDecode(nested);
    final body = nested is Map ? nested : outer;
    checkCode(body);
    String textOf(dynamic item) {
      if (item is! Map) _invalid();
      if (item['text'] != null) {
        if (item['text'] is! String) _invalid();
        return item['text'] as String;
      }
      final utterances = item['utterances'];
      if (utterances == null) return '';
      if (utterances is! List) _invalid();
      return utterances.map((u) {
        if (u is! Map || u['text'] is! String) _invalid();
        return u['text'] as String;
      }).join();
    }

    final result = body['result'];
    final text =
        (result is List
                ? result.map(textOf).join()
                : result is Map
                ? textOf(result)
                : textOf(body))
            .trim();
    if (text.length > 4000) _invalid();
    final isFinal =
        flag == 3 || data.getInt32(4) < 0 || outer['is_last_package'] == true;
    return text.isNotEmpty || isFinal
        ? CascadeTranscript(text, isFinal: isFinal)
        : null;
  } on CascadeFailure {
    rethrow;
  } catch (_) {
    return _invalid();
  }
}
