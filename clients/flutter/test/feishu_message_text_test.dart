import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/message_text.dart';

Map<String, dynamic> _message(String type, Object content) => {
  'msg_type': type,
  'body': {'content': jsonEncode(content)},
};

void main() {
  test(
    'extracts text and localized rich posts without image or action payloads',
    () {
      expect(
        feishuMessageText(_message('text', {'text': 'A message'})),
        'A message',
      );
      expect(
        feishuMessageText({'message_type': 'post', 'content': 'Rendered post'}),
        'Rendered post',
      );
      expect(
        feishuMessageText(
          _message('post', {
            'zh_cn': {
              'title': 'Project update',
              'content': [
                [
                  {'tag': 'text', 'text': 'Build '},
                  {'tag': 'a', 'text': 'passed', 'href': 'secret-url'},
                  {'tag': 'img', 'image_key': 'secret-image'},
                  {
                    'tag': 'button',
                    'text': 'secret-action',
                    'value': 'secret-value',
                  },
                ],
                [
                  {'tag': 'text', 'text': 'Ready for review'},
                ],
              ],
            },
          }),
        ),
        'Project update\nBuild passed\nReady for review',
      );
    },
  );
  test(
    'extracts visible card text while excluding executable and raw fields',
    () {
      final value = _message('interactive', {
        'header': {
          'title': {'tag': 'plain_text', 'content': 'Deployment'},
        },
        'elements': [
          {
            'tag': 'div',
            'text': {'tag': 'lark_md', 'content': 'Ready to deploy'},
            'extra': {
              'tag': 'button',
              'text': {'content': 'secret-extra'},
            },
          },
          {
            'tag': 'action',
            'actions': [
              {
                'tag': 'button',
                'text': {'content': 'secret-button'},
              },
            ],
          },
          {
            'tag': 'input',
            'label': {'tag': 'plain_text', 'content': 'secret-input'},
            'content': 'secret-input-value',
          },
          {'tag': 'select_static', 'content': 'secret-select'},
          {
            'tag': 'column_set',
            'columns': [
              {
                'tag': 'column',
                'elements': [
                  {'tag': 'markdown', 'content': 'Confirmed'},
                ],
              },
            ],
          },
        ],
        'raw_json': 'secret-json',
        'value': 'secret-value',
        'url': 'secret-url',
      });
      expect(
        feishuMessageText(value),
        'Deployment\nReady to deploy\nConfirmed',
      );
    },
  );
  test(
    'malformed bodies fail closed and unsupported media has no invented text',
    () {
      expect(
        feishuMessageText({
          'msg_type': 'image',
          'body': {'content': 'not json'},
        }),
        isNull,
      );
      expect(
        feishuMessageText(
          _message('interactive', {
            'elements': [
              {
                'tag': 'button',
                'text': {'tag': 'plain_text', 'content': 'Run'},
              },
            ],
          }),
        ),
        isNull,
      );
      expect(
        () => feishuMessageText({
          'msg_type': 'text',
          'body': {'content': '{bad'},
        }),
        throwsFormatException,
      );
      expect(
        () => feishuMessageText(
          _message('post', {
            'zh_cn': {
              'content': ['bad line'],
            },
          }),
        ),
        throwsFormatException,
      );
      expect(feishuMessageText(_message('text', {'text': '  '})), isNull);
    },
  );
  test(
    'limits decoded text, traversal depth and node count without truncating',
    () {
      final limit = List.filled(16000, 'x').join();
      expect(feishuMessageText(_message('text', {'text': limit})), limit);
      expect(
        () => feishuMessageText(_message('text', {'text': '${limit}x'})),
        throwsFormatException,
      );
      expect(
        () => feishuMessageText(
          _message('interactive', {
            'elements': [
              {'tag': 'markdown', 'content': limit},
              {'tag': 'markdown', 'content': 'x'},
            ],
          }),
        ),
        throwsFormatException,
      );
      Object nested = {'tag': 'plain_text', 'content': 'deep'};
      for (var i = 0; i < 20; i++) {
        nested = {
          'elements': [nested],
        };
      }
      expect(
        () => feishuMessageText(_message('interactive', nested)),
        throwsFormatException,
      );
      expect(
        () => feishuMessageText(
          _message('interactive', {
            'elements': List.generate(
              1001,
              (_) => {'tag': 'plain_text', 'content': 'x'},
            ),
          }),
        ),
        throwsFormatException,
      );
    },
  );
}
