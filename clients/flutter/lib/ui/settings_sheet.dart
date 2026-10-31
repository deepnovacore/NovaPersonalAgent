import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'components.dart';
import 'theme.dart';

List<(String, String, IconData)> conversationSettingsRows(String language) => [
  (
    'model_services',
    language == 'zh' ? '模型服务' : 'Model services',
    CupertinoIcons.sparkles,
  ),
  (
    'devices',
    language == 'zh' ? '设备' : 'Devices',
    CupertinoIcons.desktopcomputer,
  ),
  (
    'pet_avatar',
    language == 'zh' ? '宠物头像' : 'Pet avatar',
    CupertinoIcons.person_crop_circle,
  ),
];

Future<String?> showSettingsSheet(
  BuildContext context, {
  required String language,
  required WidgetBuilder builder,
}) => showModalBottomSheet<String>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  clipBehavior: Clip.antiAlias,
  builder: (context) => FractionallySizedBox(
    heightFactor: .9,
    child: Scaffold(
      backgroundColor: Nova.sheet,
      appBar: AppBar(
        centerTitle: true,
        automaticallyImplyLeading: false,
        title: Text(
          language == 'zh' ? '设置' : 'Settings',
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(language == 'zh' ? '完成' : 'Done'),
          ),
        ],
      ),
      body: builder(context),
    ),
  ),
);

class SettingsGroup extends StatelessWidget {
  const SettingsGroup({
    super.key,
    required this.title,
    required this.rows,
    this.subtitles = const {},
    this.selected,
    this.onSelected,
    this.disabled = const {},
  });
  final String title;
  final List<(String, String, IconData)> rows;
  final Map<String, String> subtitles;
  final String? selected;
  final ValueChanged<String>? onSelected;
  final Set<String> disabled;
  @override
  Widget build(BuildContext context) => NovaSection(
    header: title,
    surface: Nova.sheetCell,
    children: [
      for (final row in rows)
        NovaTile(
          surface: Nova.sheetCell,
          leading: NovaIconTile(row.$3),
          title: row.$2,
          subtitle: subtitles[row.$1] == null ? null : Text(subtitles[row.$1]!),
          trailing: selected == null
              ? const CupertinoListTileChevron()
              : selected == row.$1
              ? const Icon(CupertinoIcons.checkmark, size: 18, color: Nova.mint)
              : null,
          onTap: disabled.contains(row.$1)
              ? null
              : () => onSelected != null
                    ? onSelected!(row.$1)
                    : Navigator.pop(context, row.$1),
        ),
    ],
  );
}
