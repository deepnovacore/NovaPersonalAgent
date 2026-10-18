import 'package:flutter/material.dart';
import '../agent/hub_tasks.dart';
import '../personal/life_host.dart';
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
      MaterialPageRoute(
        builder: (_) => Scaffold(
          backgroundColor: Nova.sheet,
          appBar: AppBar(title: Text(_text('连接设置', 'Connection settings'))),
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
      MaterialPageRoute(
        builder: (_) => LocalTasksPage(hub: _hub, life: widget.host.repo),
      ),
    );
    if (mounted) await _load();
  }

  String _time(DateTime value) {
    final local = value.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
  }

  String _capability(String value) => switch (value) {
    'ios_native' => _text('iOS 本机操作', 'iOS native actions'),
    'android_native' => _text('Android 本机操作', 'Android native actions'),
    'desktop_computer' => _text('电脑操作', 'Computer actions'),
    'desktop_browser' => _text('浏览器操作', 'Browser actions'),
    'desktop_coding' => _text('代码任务', 'Coding tasks'),
    _ => value,
  };

  Widget _group(List<Widget> children) => Material(
    color: Nova.sheetCell,
    borderRadius: BorderRadius.circular(16),
    clipBehavior: Clip.antiAlias,
    child: Column(
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) const Divider(height: 1, indent: 56),
          children[i],
        ],
      ],
    ),
  );

  Widget _heading(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
    child: Text(
      text,
      style: const TextStyle(color: Nova.secondary, fontSize: 13),
    ),
  );

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
    final status = online == true
        ? _text('最近查询时在线', 'Online at last refresh')
        : online == false
        ? _text('离线', 'Offline')
        : _text('状态未知', 'Status unknown');
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      leading: Icon(
        capabilities.any((c) => c.startsWith('desktop_'))
            ? Icons.computer_outlined
            : Icons.phone_iphone_outlined,
        color: Nova.secondary,
      ),
      title: Text(
        device['name'] as String? ?? _text('未命名设备', 'Unnamed device'),
      ),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text(
          [
            status,
            if (lastSeen != null)
              '${_text('最近活动', 'Last seen')}：${_time(lastSeen)}',
            capabilities.isEmpty
                ? _text('未报告能力', 'No capabilities reported')
                : capabilities.map(_capability).join(' · '),
          ].join('\n'),
          style: const TextStyle(color: Nova.secondary, height: 1.5),
        ),
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
      return Scaffold(
        backgroundColor: Nova.sheet,
        appBar: AppBar(
          title: Text(
            _text('设备', 'Devices'),
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          actions: [
            IconButton(
              tooltip: _text('刷新设备', 'Refresh devices'),
              onPressed: _loading ? null : _load,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: SafeArea(
          top: false,
          child: RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: [
                _heading(_text('当前设备', 'THIS DEVICE')),
                _group([
                  ListTile(
                    contentPadding: const EdgeInsets.all(16),
                    leading: const Icon(
                      Icons.phone_iphone_outlined,
                      color: Nova.mint,
                    ),
                    title: Text(_text('这台手机', 'This phone')),
                    subtitle: Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        host.hubConfigured
                            ? '${_text('已配置 Hub', 'Hub configured')}\n$syncStatus'
                            : _text('未配置 Hub', 'Hub not configured'),
                        style: const TextStyle(
                          color: Nova.secondary,
                          height: 1.5,
                        ),
                      ),
                    ),
                  ),
                  ListTile(
                    leading: const Icon(Icons.link, color: Nova.secondary),
                    title: Text(_text('连接设置', 'Connection settings')),
                    trailing: const Icon(
                      Icons.chevron_right,
                      color: Nova.tertiary,
                    ),
                    onTap: _settings,
                  ),
                ]),
                _heading(_text('其他设备', 'OTHER DEVICES')),
                _group([
                  if (_loading)
                    Padding(
                      padding: const EdgeInsets.all(24),
                      child: Row(
                        children: [
                          const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          const SizedBox(width: 12),
                          Text(_text('正在读取设备', 'Loading devices')),
                        ],
                      ),
                    )
                  else if (_failed)
                    ListTile(
                      title: Text(_text('暂时无法读取设备', 'Devices unavailable')),
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
                    ListTile(
                      contentPadding: const EdgeInsets.all(16),
                      title: Text(_text('暂无其他设备', 'No other devices')),
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
                ]),
                _heading(_text('任务', 'TASKS')),
                _group([
                  ListTile(
                    leading: const Icon(
                      Icons.play_circle_outline,
                      color: Nova.secondary,
                    ),
                    title: Text(_text('本机与远端任务', 'Local and remote tasks')),
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
                    trailing: const Icon(
                      Icons.chevron_right,
                      color: Nova.tertiary,
                    ),
                    onTap: _tasks,
                  ),
                ]),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  child: Text(
                    _text(
                      '设备信息来自当前配置的 Hub。在线状态以最近一次查询为准。',
                      'Devices come from the configured Hub. Presence reflects the last refresh.',
                    ),
                    style: const TextStyle(
                      color: Nova.secondary,
                      fontSize: 12,
                      height: 1.5,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
