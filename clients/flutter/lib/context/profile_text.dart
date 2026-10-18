// Text-only counterpart of runtime/src/memory/sensitivity.ts; never alters sources.
String profileSafeText(String value) {
  final lines = value.split('\n');
  for (var i = 0; i + 1 < lines.length; i++) {
    if (RegExp(
          r'''^["']?(?:密码|口令|密钥|私钥|访问令牌)["']?\s*[:：=]?\s*$''',
        ).hasMatch(lines[i].trim()) &&
        RegExp(
          r'^[A-Za-z0-9!@#$%^&*_.+=/-]{3,}$',
        ).hasMatch(lines[i + 1].trim())) {
      lines[i + 1] = '[redacted]';
    }
  }
  var text = lines
      .join('\n')
      .replaceAll(
        RegExp(
          r'-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)',
        ),
        '[redacted]',
      );
  text = text.replaceAllMapped(
    RegExp(r'''https?://[^\s<>"']+''', caseSensitive: false),
    (match) {
      final url = Uri.tryParse(match[0]!);
      if (url == null) return match[0]!;
      const names = {
        'token',
        'secret',
        'password',
        'credential',
        'clientsecret',
        'apikey',
        'accesstoken',
        'refreshtoken',
      };
      bool sensitive(String name) =>
          names.contains(name.replaceAll(RegExp('[_-]'), '').toLowerCase());
      try {
        return url.userInfo.isNotEmpty ||
                url.queryParameters.keys.any(sensitive) ||
                Uri.splitQueryString(url.fragment).keys.any(sensitive)
            ? '[redacted]'
            : match[0]!;
      } on FormatException {
        return '[redacted]';
      }
    },
  );
  for (final pattern in [
    r'\b(?:proxy-)?authorization[ \t]*:[ \t]*[^\r\n]+',
    r'\b(?:set-cookie|cookie)[ \t]*:[ \t]*[^\r\n]+',
    r'''(?:\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b|["'](?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)["'])\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)''',
    r'''["']?(?:密码|口令|密钥|私钥|访问令牌|CVC|CVV|PIN|安全码)["']?\s*(?:是|为|=|:|：)\s*(?:`[^`]*`|"[^"]*"|'[^']*'|[^\s,;]+)''',
    r'''(?:密码|口令|密钥|私钥|访问令牌|CVC|CVV|安全码)[ \t]+[`"']?[A-Za-z0-9!@#$%^&*_.+=/-]{3,}[`"']?''',
    r'\b(?:sk|rk|pk|ak|xox[baprs]|ghp|github_pat)[_-][A-Za-z0-9][A-Za-z0-9_-]{11,}\b',
    r'(?:银行卡号|信用卡号|卡号)\s*\d{0,2}\s*[:：=]?\s*(?:\d[ -]?){12,19}',
    r'\bBearer\s+[A-Za-z0-9._~+/-]{8,}\b',
    r'\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b',
  ]) {
    text = text.replaceAll(RegExp(pattern, caseSensitive: false), '[redacted]');
  }
  return text;
}
