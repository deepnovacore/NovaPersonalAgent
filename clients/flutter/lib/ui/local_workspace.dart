import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../personal/life_host.dart';
import 'components.dart';
import 'local_tasks.dart';

/// Independent Space actions; Client connection controls belong to Space setup.
class LifeControls extends StatelessWidget {
  const LifeControls({super.key, required this.host});
  final LifeHost host;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: host,
    builder: (context, _) => NovaSection(
      header: '本机事项',
      footer:
          host.error ??
          (host.repo == null ? '正在打开本机事项' : '独立运行，事项保存在这个 Space。'),
      children: [
        NovaTile(
          leading: const NovaIconTile(CupertinoIcons.play_circle),
          title: '任务与执行记录',
          trailing: const CupertinoListTileChevron(),
          onTap: host.repo == null
              ? null
              : () => Navigator.push<void>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => LocalTasksPage(life: host.repo),
                  ),
                ),
        ),
      ],
    ),
  );
}
