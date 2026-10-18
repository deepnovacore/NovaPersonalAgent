import 'package:flutter/material.dart';
import '../personal/life_host.dart';
import '../agent_core/model_settings.dart';
import '../context/profile_corrections.dart';

class AuthorityControls extends StatefulWidget {
  const AuthorityControls({super.key, required this.host});
  final LifeHost host;
  @override
  State<AuthorityControls> createState() => _AuthorityControlsState();
}

class _AuthorityControlsState extends State<AuthorityControls> {
  String? error;
  Future<void> _correct() async {
    final model = await ModelSettings().read();
    if (model == null || !mounted) return;
    final provider = '${model.endpoint}|${model.model}';
    final key = TextEditingController(text: 'about'),
        value = TextEditingController();
    try {
      final accepted = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('纠正个人信息'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              DropdownButtonFormField<String>(
                initialValue: 'about',
                items: [
                  for (final entry in ProfileCorrections.categories.entries)
                    DropdownMenuItem(
                      value: entry.key,
                      child: Text(entry.value),
                    ),
                ],
                onChanged: (v) => key.text = v!,
              ),
              Text('同步此类的完整纠正，并允许 $provider 用于画像和对话。'),
              TextField(
                controller: value,
                maxLines: 3,
                decoration: const InputDecoration(labelText: '以你的表述为准'),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('保存纠正'),
            ),
          ],
        ),
      );
      if (accepted == true) {
        final sync = await widget.host.getContextSync();
        await sync.correct(
          key.text.trim(),
          value.text.trim(),
          provider: provider,
        );
      }
    } finally {
      key.dispose();
      value.dispose();
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
      if (mounted) setState(() => error = null);
    } catch (_) {
      if (mounted) {
        setState(() => error = '主设备操作未完成。请确认 Hub 支持此协议、设备身份和交接状态；不会自动改选主设备。');
      }
    }
  }

  Future<void> _transfer() async {
    final members = await widget.host.authorityMembers();
    if (!mounted) return;
    final selected = await showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('选择主电脑'),
        children: [
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text('选择后暂停正式画像发布。目标电脑确认接管后，在此完成切换。已有任务不会因此迁移。'),
          ),
          for (final member in members.where(
            (m) =>
                m['kind'] == 'desktop' &&
                m['revoked'] == 0 &&
                m['device_id'] != widget.host.authority.deviceId,
          ))
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, member['device_id']),
              child: Text(member['device_id']),
            ),
        ],
      ),
    );
    if (selected != null) await widget.host.transferAuthority(selected);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.host,
    builder: (context, _) {
      final host = widget.host;
      if (!host.authorityReady) return const SizedBox.shrink();
      final authority = host.authority, pending = authority.record['pending'];
      return Column(
        children: [
          ListTile(
            title: Text(switch (authority.status) {
              'transitioning' => '主设备切换中',
              'pc_primary' => '主电脑维护正式画像',
              'mobile_replica' => '当前手机接收正式画像',
              _ => '手机独立运行',
            }),
            subtitle: Text(
              authority.status == 'pc_primary'
                  ? '主电脑：${authority.primaryDeviceId}\n电脑离线时保留现有版本，等待电脑更新。'
                  : '正式画像发布者：${authority.primaryDeviceId}',
            ),
          ),
          if (host.hubConfigured && authority.hubId == null)
            TextButton(
              onPressed: host.busy ? null : () => _run(host.joinAuthority),
              child: const Text('加入 Hub 的主设备关系'),
            ),
          if (authority.hubId != null && authority.canPublish)
            TextButton(
              onPressed: host.busy ? null : () => _run(_transfer),
              child: const Text('选择主电脑并开始交接'),
            ),
          if (pending != null &&
              pending['target_device_id'] == authority.deviceId)
            TextButton(
              onPressed: host.busy
                  ? null
                  : () => _run(() => host.authorityTransition('ack')),
              child: const Text('确认接管'),
            ),
          if (pending != null &&
              pending['from_device_id'] == authority.deviceId)
            Wrap(
              children: [
                TextButton(
                  onPressed: host.busy
                      ? null
                      : () => _run(() => host.authorityTransition('commit')),
                  child: const Text('完成切换'),
                ),
                TextButton(
                  onPressed: host.busy
                      ? null
                      : () => _run(() => host.authorityTransition('cancel')),
                  child: const Text('取消交接'),
                ),
              ],
            ),
          if (error != null) Text(error!),
          if (host.contextSync != null) ...[
            Text(
              '${host.contextSync!.pending} 条事实待上传 · ${host.contextSync!.pendingDeletes.length} 个跨端删除待确认',
            ),
            if (host.contextSync!.pendingDeviceAcks.isNotEmpty)
              Text(
                '尚有 ${host.contextSync!.pendingDeviceAcks.length} 台设备未确认最新清理状态；离线副本可能仍保留内容。',
              ),
            TextButton(
              onPressed: () => _run(_correct),
              child: const Text('纠正个人信息'),
            ),
            for (final entry in host.contextSync!.corrections.entries)
              ListTile(
                title: Text(entry.value as String),
                subtitle: Text('你的明确纠正 · ${entry.key}'),
              ),
            if (host.contextSync!.derived case final projection?)
              if (projection['authority_epoch'] == authority.epoch &&
                  projection['publisher_device_id'] ==
                      authority.primaryDeviceId)
                for (final entry in projection['entries'] as List)
                  if (!host.contextSync!.corrections.containsKey(entry['key']))
                    ListTile(
                      title: Text(entry['text']),
                      subtitle: Text(
                        '正式画像版本 ${projection['revision']} · ${entry['key']}',
                      ),
                    ),
          ],
        ],
      );
    },
  );
}
