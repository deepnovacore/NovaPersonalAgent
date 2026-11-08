import 'package:flutter/material.dart';
import '../space/space_storage.dart';
import 'persona.dart';
import 'experience_session.dart';
import 'experience_code_dialog.dart';

class ExperienceChooser extends StatefulWidget {
  const ExperienceChooser({
    super.key,
    required this.catalog,
    this.language = 'zh',
  });
  final SpaceCatalog catalog;
  final String language;
  @override
  State<ExperienceChooser> createState() => _ExperienceChooserState();
}

class _ExperienceChooserState extends State<ExperienceChooser> {
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  final session = ExperienceSession();
  bool busy = false;
  String? notice;
  @override
  void dispose() {
    session.dispose();
    super.dispose();
  }

  Future<void> redeem() async {
    final redeemed = await showExperienceCodeDialog(
      context,
      session: session,
      language: widget.language,
    );
    if (mounted && redeemed) {
      setState(
        () =>
            notice = t('已兑换，可以开始对话。', 'Code redeemed. You can start chatting.'),
      );
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
        Text(
          t(
            '选择示例人物，浏览示例资料。',
            'Choose a sample persona and browse the sample data.',
          ),
        ),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton(
            onPressed: busy ? null : redeem,
            child: Text(t('体验码', 'Experience code')),
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
