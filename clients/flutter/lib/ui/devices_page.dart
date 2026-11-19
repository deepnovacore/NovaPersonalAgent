import 'package:flutter/cupertino.dart';
import '../personal/life_host.dart';
import 'components.dart';
import 'local_tasks.dart';

class DevicesPage extends StatelessWidget {
  const DevicesPage({super.key, required this.host, this.language = 'zh'});
  final LifeHost host;
  final String language;
  String t(String zh, String en) => language == 'zh' ? zh : en;
  @override
  Widget build(BuildContext context) => NovaPage(
    title: t('设备', 'Devices'),
    body: SafeArea(
      child: ListView(
        children: [
          NovaSection(
            header: t('当前 Space', 'CURRENT SPACE'),
            children: [
              NovaTile(
                leading: const NovaIconTile(
                  CupertinoIcons.device_phone_portrait,
                ),
                title: t('这台设备', 'This device'),
                subtitle: Text(
                  t(
                    '独立运行，数据保存在本机。',
                    'Independent Space. Data stays on this device.',
                  ),
                ),
              ),
              NovaTile(
                leading: const NovaIconTile(CupertinoIcons.play_circle),
                title: t('任务与执行记录', 'Tasks and activity'),
                trailing: const CupertinoListTileChevron(),
                onTap: () => Navigator.push<void>(
                  context,
                  CupertinoPageRoute(
                    builder: (_) => LocalTasksPage(life: host.repo),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}
