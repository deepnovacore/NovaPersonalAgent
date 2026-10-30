import 'dart:convert';

/// Visible message text only. Actions, inputs and metadata never become prose.
/// Limits reject the whole body so callers can report skipped content honestly.
String? feishuMessageText(Map message) {
  const maxChars = 16000, maxDepth = 12, maxNodes = 1000;
  final type = message['msg_type'] ?? message['message_type'];
  if (!const ['text', 'post', 'interactive'].contains(type)) return null;
  const malformed = FormatException('feishu_message_body_invalid');
  const tooLarge = FormatException('feishu_message_too_large');
  const structureLimit = FormatException('feishu_message_structure_limit');
  String? checked(String text) {
    if (text.length > maxChars) throw tooLarge;
    return text.trim().isEmpty ? null : text;
  }

  final rendered = message['content'];
  if (rendered is String &&
      !rendered.trimLeft().startsWith('{') &&
      !rendered.trimLeft().startsWith('[')) {
    return checked(rendered);
  }
  final body = message['body'];
  var raw = rendered ?? (body is Map ? body['content'] : null);
  if (raw is String) {
    if (raw.length > 256 * 1024) throw structureLimit;
    try {
      raw = jsonDecode(raw);
    } on FormatException {
      throw malformed;
    }
  }
  if (raw is! Map) throw malformed;
  if (type == 'text') {
    final text = raw['text'];
    if (text is! String) throw malformed;
    return checked(text);
  }

  var nodes = 0, length = 0;
  void visit(int depth) {
    if (depth > maxDepth || ++nodes > maxNodes) throw structureLimit;
  }

  final lines = <String>[];
  void add(String text) {
    if (text.trim().isEmpty) return;
    length += text.length + (lines.isEmpty ? 0 : 1);
    if (length > maxChars) throw tooLarge;
    lines.add(text);
  }

  if (type == 'post') {
    visit(0);
    Map post = raw;
    if (post['content'] is! List) {
      final locales = [raw['zh_cn'], raw['en_us'], ...raw.values];
      final localized = locales
          .whereType<Map>()
          .where((p) => p['content'] is List)
          .firstOrNull;
      if (localized == null) throw malformed;
      post = localized;
    }
    final title = post['title'];
    if (title != null && title is! String) throw malformed;
    if (title is String) add(title);
    final content = post['content'];
    if (content is! List) throw malformed;
    for (final line in content) {
      visit(1);
      if (line is! List) throw malformed;
      final text = StringBuffer();
      for (final node in line) {
        visit(2);
        if (node is! Map) throw malformed;
        if (!const ['text', 'a', 'code_block'].contains(node['tag'])) continue;
        final part = node['text'];
        if (part is! String) throw malformed;
        if (text.length + part.length > maxChars) throw tooLarge;
        text.write(part);
      }
      add(text.toString());
    }
  } else {
    void walk(Object? value, int depth) {
      visit(depth);
      if (value is String) {
        add(value);
        return;
      }
      if (value is List) {
        for (final item in value) {
          walk(item, depth + 1);
        }
      } else if (value is Map) {
        final tag = value['tag'];
        if (tag != null &&
            !const [
              'plain_text',
              'lark_md',
              'markdown',
              'div',
              'note',
              'column_set',
              'column',
              'hr',
            ].contains(tag)) {
          return;
        }
        for (final key in const [
          'header',
          'title',
          'text',
          'content',
          'elements',
          'fields',
          'body',
          'columns',
          'column_set',
        ]) {
          if (value.containsKey(key)) walk(value[key], depth + 1);
        }
      }
    }

    walk(raw, 0);
  }
  return lines.isEmpty ? null : lines.join('\n');
}
