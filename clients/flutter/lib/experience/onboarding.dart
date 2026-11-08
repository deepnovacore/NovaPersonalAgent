import 'package:flutter/material.dart';
import '../space/space_storage.dart';
import 'persona.dart';
import 'experience_session.dart';

class ExperienceChooser extends StatefulWidget {
  const ExperienceChooser({
    super.key,
    required this.catalog,
    this.language = 'zh',
    this.allowInvite = true,
  });
  final SpaceCatalog catalog;
  final String language;
  final bool allowInvite;
  @override
  State<ExperienceChooser> createState() => _ExperienceChooserState();
}

class _ExperienceChooserState extends State<ExperienceChooser> {
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  final code = TextEditingController();
  final session = ExperienceSession();
  bool busy = false;
  String? notice;
  @override
  void dispose() {
    code.dispose();
    session.dispose();
    super.dispose();
  }

  Future<void> redeem() async {
    if (!widget.allowInvite || busy || code.text.trim().isEmpty) return;
    setState(() {
      busy = true;
      notice = null;
    });
    try {
      await session.redeem(code.text);
      if (mounted) {
        setState(() {
          notice = t('体验资格已启用', 'Experience access enabled');
          code.clear();
        });
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => notice = t(
            '无法兑换，请检查体验码或稍后重试。',
            'Could not redeem. Check your code or try again later.',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> select(ExperiencePersona persona) async {
    if (busy) return;
    setState(() {
      busy = true;
      notice = null;
    });
    try {
      final existing = widget.catalog.spaces
          .where((s) => s.personaId == persona.id)
          .firstOrNull;
      if (existing != null) {
        await widget.catalog.select(existing.id);
      } else {
        final space = SpaceRecord(
          id: newSpaceId(),
          name: persona.name,
          mode: SpaceMode.standalone,
          personaId: persona.id,
          experienceSeededAt: ExperiencePersona.localDayAnchor(),
        );
        await ExperiencePersona.seed(space);
        if (!mounted) return;
        await widget.catalog.add(space);
      }
      if (mounted) Navigator.pop(context);
    } catch (_) {
      if (mounted) {
        setState(
          () => notice = t(
            '无法打开示例资料，请稍后重试。',
            'Could not open sample data. Try again later.',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(t('体验 Space', 'Experience Spaces'))),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        if (widget.allowInvite) ...[
          Text(
            t(
              '示例资料可以离线浏览。在线对话和重新提取需要先兑换体验码。',
              'Browse sample data offline. Redeem a code to chat online or refresh the profile.',
            ),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: code,
            enabled: !busy,
            autocorrect: false,
            decoration: InputDecoration(labelText: t('体验码', 'Experience code')),
            onSubmitted: (_) => redeem(),
          ),
          FilledButton(
            onPressed: busy ? null : redeem,
            child: Text(t('兑换体验码', 'Redeem experience code')),
          ),
        ] else
          Text(
            t(
              '选择示例人物，离线浏览资料。在线功能需要有效体验资格。',
              'Choose a sample persona to browse offline. Online features require active experience access.',
            ),
          ),
        if (notice != null) Text(notice!),
        if (busy) const LinearProgressIndicator(),
        const SizedBox(height: 16),
        for (final persona in ExperiencePersona.choices)
          ListTile(
            leading: persona.avatar(),
            title: Text(persona.name),
            subtitle: Text(persona.occupation),
            onTap: busy ? null : () => select(persona),
          ),
      ],
    ),
  );
}
