import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_text.dart';
import 'package:nova_mobile/context/profile_evidence.dart';

void main() {
  test(
    'desktop credential cases are removed while ordinary project text stays',
    () {
      for (final secret in [
        'password=synthetic-value',
        '密码：synthetic-value',
        '密码\nsynthetic-value',
        'Authorization: Bearer synthetic-value',
        'Cookie: session=synthetic-value',
        'https://example.test/?access_token=synthetic-value',
        'https://example.test/#api_key=synthetic-value',
        'https://user:synthetic-value@example.test/',
        '-----BEGIN PRIVATE KEY-----\nsynthetic-value\n-----END PRIVATE KEY-----',
        'sk-syntheticsecret12345',
      ]) {
        final text = profileSafeText('推进项目\n$secret\n与同事核对设计');
        expect(text, contains('推进项目'));
        expect(text, contains('与同事核对设计'));
        expect(text, isNot(contains('synthetic')));
      }
      expect(
        profileSafeText('Nova 设计 https://example.test/docs?q=design'),
        'Nova 设计 https://example.test/docs?q=design',
      );
      expect(
        profileSafeText('项目\n-----BEGIN PRIVATE KEY-----\nsynthetic-value'),
        '项目\n[redacted]',
      );
    },
  );

  test(
    'later self copy cannot become self evidence and original stays intact',
    () {
      final copied = List.filled(40, '项目方案').join();
      final originals = [
        {
          'evidence_id': 'other',
          'chat_id': 'chat',
          'sender_id': 'other',
          'relation': 'participant',
          'created_at': 1792195200000,
          'text': copied,
        },
        {
          'evidence_id': 'copy',
          'chat_id': 'chat',
          'sender_id': 'self',
          'relation': 'self',
          'created_at': 1792195200001,
          'text': copied,
        },
        {
          'evidence_id': 'own',
          'chat_id': 'chat',
          'sender_id': 'self',
          'relation': 'self',
          'created_at': 1792195200002,
          'text': '继续推进；password=synthetic-value',
        },
      ];
      final evidence = ProfileEvidence(originals);
      expect(evidence.records.length, 2);
      expect(evidence.records.first['relation'], 'participant');
      expect(evidence.records.last['text'], isNot(contains('synthetic')));
      expect(evidence.records.last['body_authorship'], 'unverified');
      expect(originals.last['text'], contains('synthetic'));
    },
  );
}
