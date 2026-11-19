import 'package:flutter/material.dart';
import 'strings.dart';

/// Inline only: updating news preferences never records personal facts.
class NewsInterests extends StatefulWidget {
  const NewsInterests({
    super.key,
    required this.news,
    required this.configure,
    this.available = true,
    this.language = 'en',
  });
  final Map news;
  final Future<void> Function(List<String>) configure;
  final bool available;
  final String language;

  @override
  State<NewsInterests> createState() => _NewsInterestsState();
}

class _NewsInterestsState extends State<NewsInterests> {
  final _word = TextEditingController();
  bool _busy = false, _failed = false;
  String t(String text) => tr(widget.language, text);
  List<String> get _interests => (widget.news['interests'] as List? ?? [])
      .map((i) => i is Map ? '${i['text']}' : '$i')
      .toList();

  Future<void> _save(List<String> values, {bool added = false}) async {
    if (_busy || !widget.available) return;
    setState(() {
      _busy = true;
      _failed = false;
    });
    try {
      await widget.configure(values);
      if (mounted && added) _word.clear();
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _add() {
    final word = _word.text.trim(), interests = _interests;
    if (word.isEmpty || interests.contains(word) || interests.length >= 8) {
      return;
    }
    _save([...interests, word], added: true);
  }

  @override
  Widget build(BuildContext context) {
    final interests = _interests, active = widget.available && !_busy;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 6,
        runSpacing: 2,
        children: [
          Text(t('Interests'), style: Theme.of(context).textTheme.labelSmall),
          for (final word in interests)
            InputChip(
              label: Text(word),
              visualDensity: VisualDensity.compact,
              onDeleted: active
                  ? () => _save(interests.where((i) => i != word).toList())
                  : null,
              deleteButtonTooltipMessage: t('Remove interest'),
            ),
          SizedBox(
            width: 140,
            child: TextField(
              key: const ValueKey('news.interest.word'),
              controller: _word,
              enabled: active && interests.length < 8,
              maxLength: 100,
              style: Theme.of(context).textTheme.bodySmall,
              decoration: InputDecoration(
                isDense: true,
                counterText: '',
                hintText: t('Add interest'),
                suffixIcon: IconButton(
                  tooltip: t('Add interest'),
                  onPressed: active && interests.length < 8 ? _add : null,
                  icon: const Icon(Icons.add, size: 18),
                ),
              ),
              onSubmitted: (_) => _add(),
            ),
          ),
          if (_failed) Text(t('Could not save news. Please try again.')),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _word.dispose();
    super.dispose();
  }
}
