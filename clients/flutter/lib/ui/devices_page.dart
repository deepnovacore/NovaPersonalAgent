import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../agent/hub_tasks.dart';
import '../personal/life_host.dart';
import 'components.dart';
import 'local_tasks.dart';
import 'local_workspace.dart';
import 'theme.dart';

/// Read-only device presence. Task execution begins only in the task page.
class DevicesPage extends StatefulWidget {
  const DevicesPage({super.key, required this.host, this.language = 'zh'});
  final LifeHost host;
  final String language;

  @override
  State<DevicesPage> createState() => _DevicesPageState();
}

class _DevicesPageState extends State<DevicesPage> {
  List<Map<String, dynamic>> _devices = [];
  HubTasks? _hub;
  bool _loading = true;
  bool _failed = false;
  int _generation = 0;
  String _text(String zh, String en) => widget.language == 'zh' ? zh : en;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(DevicesPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.host != widget.host) _load();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    final host = widget.host;
    setState(() {
      _loading = true;
      _failed = false;
      _hub = null;
      _devices = [];
    });
    try {
      await host.open();
      final hub = host.hubConfigured ? await host.getTasks() : null;
      final rows = hub == null ? <dynamic>[] : await hub.devices();
      if (!mounted || generation != _generation) return;
      setState(() {
        _hub = hub;
        _devices = rows
            .map((row) => Map<String, dynamic>.from(row as Map))
            .toList();
      });
    } catch (_) {
      // Transport failures can contain credentials; never display their text.
      if (mounted && generation == _generation) setState(() => _failed = true);
    } finally {
      if (mounted && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _settings() async {
    await Navigator.push<void>(
      context,
      CupertinoPageRoute(
        builder: (_) => NovaPage(
          title: _text('连接设置', 'Connection settings'),
          body: SafeArea(
            child: SingleChildScrollView(
              child: LifeControls(host: widget.host),
            ),
          ),
        ),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _tasks() async {
    await Navigator.push<void>(
      context,
      CupertinoPageRoute(
        builder: (_) => LocalTasksPage(hub: _hub, life: widget.host.repo),
      ),
    );
    if (mounted) await _load();
  }

  String _time(DateTime value) =>
      relativeTime(value.toIso8601String(), _text('zh', 'en'));

  String _capability(String value) => switch (value) {
    'ios_native' => _text('iOS 本机操作', 'iOS native actions'),
    'android_native' => _text('Android 本机操作', 'Android native actions'),
    'desktop_computer' => _text('电脑操作', 'Computer actions'),
    'desktop_browser' => _text('浏览器操作', 'Browser actions'),
    'desktop_coding' => _text('代码任务', 'Coding tasks'),
    _ => _text('其他能力', 'Other capability'),
  };

  Widget _device(Map<String, dynamic> device) {
    final capabilities = (device['capabilities'] as List? ?? [])
        .whereType<String>()
        .toList();
    final seen = device['last_seen'];
    final lastSeen =
        seen is num && seen.isFinite && seen.abs() <= 8640000000000000
        ? DateTime.fromMillisecondsSinceEpoch(seen.toInt())
        : null;
    final online = device['online'];
    return NovaTile(
      surface: Nova.sheetCell,
      leading: NovaIconTile(
        capabilities.any((c) => c.startsWith('desktop_'))
            ? CupertinoIcons.desktopcomputer
            : CupertinoIcons.device_phone_portrait,
        color: Nova.secondary,
      ),
      title: device['name'] as String? ?? _text('未命名设备', 'Unnamed device'),
      subtitle: Text(
        [
          if (lastSeen != null)
            '${_text('最近活动', 'Last seen')}：${_time(lastSeen)}',
          capabilities.isEmpty
              ? _text('未报告能力', 'No capabilities reported')
              : capabilities.map(_capability).join(' · '),
        ].join('\n'),
      ),
      trailing: NovaStatusChip(
        online == true
            ? _text('在线', 'Online')
            : online == false
            ? _text('离线', 'Offline')
            : _text('状态未知', 'Unknown'),
        tone: online == true ? NovaTone.success : NovaTone.neutral,
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.host,
    builder: (context, _) {
      final host = widget.host;
      final syncStatus = host.hasConflict
          ? _text(
              '同步有冲突，请在连接设置中处理',
              'Resolve the sync conflict in connection settings',
            )
          : host.error != null
          ? _text(
              '同步暂不可用，请检查连接设置',
              'Sync unavailable; check connection settings',
            )
          : host.busy
          ? _text('正在连接 Hub', 'Contacting Hub')
          : host.lastSync != null
          ? '${_text('最近同步', 'Last synced')}：${_time(host.lastSync!)}'
          : _text('尚未完成同步', 'Not synced yet');
      return NovaPage(
        title: _text('设备', 'Devices'),
        actions: [
          IconButton(
            tooltip: _text('刷新设备', 'Refresh devices'),
            onPressed: _loading ? null : _load,
            icon: const Icon(CupertinoIcons.arrow_clockwise),
          ),
        ],
        body: SafeArea(
          top: false,
          child: RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.only(top: 8, bottom: 32),
              children: [
                NovaSection(
                  header: _text('当前设备', 'THIS DEVICE'),
                  surface: Nova.sheetCell,
                  children: [
                    NovaTile(
                      surface: Nova.sheetCell,
                      leading: const NovaIconTile(
                        CupertinoIcons.device_phone_portrait,
                      ),
                      title: _text('这台手机', 'This phone'),
                      subtitle: Text(
                        host.hubConfigured
                            ? '${_text('已配置 Hub', 'Hub configured')}\n$syncStatus'
                            : _text('未配置 Hub', 'Hub not configured'),
                      ),
                    ),
                    NovaTile(
                      surface: Nova.sheetCell,
                      leading: const NovaIconTile(
                        CupertinoIcons.link,
                        color: Nova.secondary,
                      ),
                      title: _text('连接设置', 'Connection settings'),
                      trailing: const CupertinoListTileChevron(),
                      onTap: _settings,
                    ),
                  ],
                ),
                NovaSection(
                  header: _text('其他设备', 'OTHER DEVICES'),
                  surface: Nova.sheetCell,
                  children: [
                    if (_loading)
                      NovaTile(
                        surface: Nova.sheetCell,
                        leading: const SizedBox(
                          width: 18,
                          height: 18,
                          child: CupertinoActivityIndicator(),
                        ),
                        title: _text('正在读取设备', 'Loading devices'),
                      )
                    else if (_failed)
                      NovaTile(
                        surface: Nova.sheetCell,
                        title: _text('暂时无法读取设备', 'Devices unavailable'),
                        subtitle: Text(
                          _text(
                            '请检查 Hub 地址、设备令牌或网络连接。',
                            'Check your Hub URL, device token, or connection.',
                          ),
                        ),
                        trailing: TextButton(
                          onPressed: _load,
                          child: Text(_text('重试', 'Retry')),
                        ),
                      )
                    else if (_devices.isEmpty)
                      NovaTile(
                        surface: Nova.sheetCell,
                        title: _text('暂无其他设备', 'No other devices'),
                        subtitle: Text(
                          host.hubConfigured
                              ? _text(
                                  '此 Hub 尚未报告其他设备。',
                                  'This Hub has not reported other devices.',
                                )
                              : _text(
                                  '使用 Hub 地址和设备令牌连接后，可查看该 Hub 中的设备。',
                                  'Connect with a Hub URL and device token to view its devices.',
                                ),
                        ),
                      )
                    else
                      ..._devices.map(_device),
                  ],
                ),
                NovaSection(
                  header: _text('任务', 'TASKS'),
                  surface: Nova.sheetCell,
                  footer: _text(
                    '在线状态以最近一次刷新为准。',
                    'Online status reflects the last refresh.',
                  ),
                  children: [
                    NovaTile(
                      surface: Nova.sheetCell,
                      leading: const NovaIconTile(
                        CupertinoIcons.play_circle,
                        color: Nova.secondary,
                      ),
                      title: _text('本机与远端任务', 'Local and remote tasks'),
                      subtitle: Text(
                        _hub == null
                            ? _text(
                                '查看本机任务；远端任务需要可用的 Hub。',
                                'View local tasks; remote tasks need an available Hub.',
                              )
                            : _text(
                                '查看执行进度与待确认的委托',
                                'View progress and requests awaiting approval',
                              ),
                      ),
                      trailing: const CupertinoListTileChevron(),
                      onTap: _tasks,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
