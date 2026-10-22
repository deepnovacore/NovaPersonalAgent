import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';

/// The Swift client strips heading markers and renders each line separately.
class AssistantText extends StatelessWidget {
  const AssistantText(this.text, {super.key, this.onArtifactLink});
  final String text;

  /// Opens a workspace URL/path or a legacy artifact ID inside Nova.
  final Future<void> Function(String pathOrId)? onArtifactLink;

  Iterable<Uri> get _previewLinks sync* {
    final seen = <String>{};
    for (final match in RegExp(
      r'''nova-file:///workspace/[^\s`<>"\[\]，。；：！？、（）]+''',
    ).allMatches(text)) {
      final url = match[0]!.replaceFirst(RegExp(r'[).,;:!]+$'), '');
      if (!seen.add(url) ||
          text.contains(']($url)') ||
          text.contains('](<$url>)') ||
          text.contains('<$url>')) {
        continue;
      }
      try {
        final uri = Uri.parse(url);
        if (uri.host.isEmpty &&
            !uri.hasQuery &&
            !uri.hasFragment &&
            uri.path.startsWith('/workspace/') &&
            !uri.pathSegments.contains('..') &&
            RegExp(r'\.html?$', caseSensitive: false).hasMatch(uri.path)) {
          yield uri;
        }
      } on FormatException {
        // Malformed model output stays visible as text.
      }
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      for (final line in text.split('\n'))
        MarkdownBody(
          data: line.replaceFirst(RegExp(r'^#{1,6} +'), ''),
          selectable: true,
          imageBuilder: (_, title, alt) => Text(alt ?? title ?? ''),
          onTapLink: (_, href, _) async {
            final uri = Uri.tryParse(href ?? '');
            if (uri?.scheme == 'nova-artifact' &&
                uri!.host.isNotEmpty &&
                onArtifactLink != null) {
              await onArtifactLink!(uri.host);
              return;
            }
            if (uri != null &&
                (uri.scheme == 'nova-file' ||
                    (uri.scheme.isEmpty &&
                        uri.path.startsWith('/workspace/'))) &&
                onArtifactLink != null) {
              await onArtifactLink!(href!);
              return;
            }
            if (uri != null &&
                ['https', 'http', 'mailto'].contains(uri.scheme)) {
              await launchUrl(uri, mode: LaunchMode.externalApplication);
            }
          },
        ),
      if (onArtifactLink != null)
        for (final uri in _previewLinks)
          TextButton.icon(
            onPressed: () => onArtifactLink!(uri.toString()),
            icon: const Icon(Icons.open_in_new, size: 18),
            label: Text(uri.pathSegments.last),
          ),
    ],
  );
}
