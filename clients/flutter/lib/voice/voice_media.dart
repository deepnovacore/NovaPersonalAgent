import 'dart:convert';
import 'dart:typed_data';
import '../protocol/wire.dart';

Uint8List voiceFrame(PlaybackIdentity identity, int sequence, Uint8List pcm) {
  if (pcm.isEmpty || pcm.length.isOdd || pcm.length > Wire.maxPCM) {
    throw const FormatException('invalid_voice_pcm');
  }
  final header = utf8.encode(
    jsonEncode({...identity.fields, 'sequence': sequence}),
  );
  if (header.length > Wire.maxHeader) {
    throw const FormatException('invalid_voice_identity');
  }
  final output = Uint8List(6 + header.length + pcm.length);
  output.setRange(0, 4, [78, 79, 86, 65]);
  ByteData.sublistView(output).setUint16(4, header.length, Endian.big);
  output.setRange(6, 6 + header.length, header);
  output.setRange(6 + header.length, output.length, pcm);
  return output;
}
