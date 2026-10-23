import 'dart:async';
import 'package:flutter/material.dart';
import 'client_state.dart';
import 'space_dialog.dart';

/// Captured input and authorization are requests to Host, never a second local
/// profile producer. Pending source text remains durable until its Host receipt.
class SpaceSourcePanel extends StatefulWidget {
  const SpaceSourcePanel({
    super.key,
    required this.state,
    required this.onSync,
  });
  final SpaceClientState state;
  final Future<void> Function() onSync;
  @override
  State<SpaceSourcePanel> createState() => _SpaceSourcePanelState();
}

class _SpaceSourcePanelState extends State<SpaceSourcePanel> {
  Future<void> collect({Map<String, dynamic>? source}) async {
    final name = TextEditingController(
      text: source?['name'] as String? ?? '手机输入',
    );
    final text = TextEditingController();
    final currentProvider =
        (widget.state.snapshot['processing_provider'] as Map?)
            ?.cast<String, dynamic>();
    var upload = false, processing = false;
    final provider = currentProvider?['id'] as String? ?? 'upload-only';
    final save = await showSpaceDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialog) => AlertDialog(
          title: const Text('向 Host 发送采集输入'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: name,
                    decoration: const InputDecoration(labelText: '来源名称'),
                    maxLength: 100,
                  ),
                  TextField(
                    controller: text,
                    decoration: const InputDecoration(labelText: '你采集的内容'),
                    minLines: 4,
                    maxLines: 8,
                    maxLength: 16000,
                  ),
                  Text(
                    currentProvider == null
                        ? 'Host 尚未配置模型：可上传，不会进行模型处理。'
                        : 'Host 模型：${currentProvider['label']}\n授权仅限当前配置，Host 更换模型需重新授权。',
                  ),
                  CheckboxListTile(
                    value: upload,
                    title: const Text('允许将这份内容发送并保存在 Host'),
                    onChanged: (value) =>
                        setDialog(() => upload = value ?? false),
                  ),
                  CheckboxListTile(
                    value: processing,
                    title: const Text('允许 Host 使用模型处理这份内容'),
                    subtitle: const Text('不勾选时仅上传，不用于模型推断个人资料。'),
                    onChanged: currentProvider == null
                        ? null
                        : (value) =>
                              setDialog(() => processing = value ?? false),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: upload ? () => Navigator.pop(context, true) : null,
              child: const Text('授权并发送'),
            ),
          ],
        ),
      ),
    );
    if (save == true && text.text.trim().isNotEmpty) {
      await widget.state.collectSource(
        name: name.text.trim(),
        text: text.text,
        provider: provider,
        allowProcessing: processing,
        sourceId: source?['id'] as String?,
      );
      unawaited(widget.onSync());
    }
    name.dispose();
    text.dispose();
  }

  Future<void> correction() async {
    final text = TextEditingController();
    var key = 'about';
    final save = await showSpaceDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('向 Host 纠正个人资料'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DropdownButtonFormField<String>(
              initialValue: key,
              items: const [
                DropdownMenuItem(value: 'about', child: Text('个人情况')),
                DropdownMenuItem(value: 'work', child: Text('工作')),
                DropdownMenuItem(value: 'interests', child: Text('兴趣')),
              ],
              onChanged: (v) => key = v!,
            ),
            TextField(
              controller: text,
              minLines: 3,
              maxLines: 5,
              maxLength: 2600,
              decoration: const InputDecoration(labelText: '正确内容'),
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
            child: const Text('发送纠正'),
          ),
        ],
      ),
    );
    if (save == true && text.text.trim().isNotEmpty) {
      await widget.state.enqueue('source.input', {
        'kind': 'correction',
        'key': key,
        'value': text.text.trim(),
      });
      unawaited(widget.onSync());
    }
    text.dispose();
  }

  Future<void> remove(Map<String, dynamic> source, bool delete) async {
    final ok = await showSpaceDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(delete ? '删除采集来源？' : '撤销采集授权？'),
        content: Text(
          delete
              ? '将请求 Host 删除这个来源及由它派生的资料。处理结果以 Host 回执为准。'
              : '将禁止 Host 继续上传和处理这个来源。Host 离线时会等待同步；已发送内容在撤销请求生效前仍可能被处理。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('确认'),
          ),
        ],
      ),
    );
    if (ok == true) {
      await widget.state.revokeSource(source['id'] as String, delete: delete);
      unawaited(widget.onSync());
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const SizedBox(height: 20),
      Text('手机采集与授权', style: Theme.of(context).textTheme.titleLarge),
      const Text('由你选择内容并授权 Host 处理。此设备不运行个人资料推断。'),
      Wrap(
        spacing: 8,
        children: [
          OutlinedButton.icon(
            onPressed: collect,
            icon: const Icon(Icons.note_add_outlined),
            label: const Text('发送采集输入'),
          ),
          TextButton(onPressed: correction, child: const Text('纠正个人资料')),
        ],
      ),
      for (final source in widget.state.clientSources.values)
        Card(
          child: ListTile(
            title: Text(source['name'] as String? ?? '手机输入'),
            subtitle: Text(
              '${_status(source['status'] as String?)} · ${source['allow_processing'] == true ? '允许模型处理' : '禁止模型处理'}${source['error'] == null ? '' : ' · ${source['error']}'}',
            ),
            trailing: source['status'] == 'deleted'
                ? null
                : PopupMenuButton<String>(
                    onSelected: (action) {
                      if (action == 'edit') {
                        unawaited(collect(source: source));
                      } else {
                        unawaited(remove(source, action == 'delete'));
                      }
                    },
                    itemBuilder: (_) => [
                      const PopupMenuItem(
                        value: 'edit',
                        child: Text('修改并重新授权'),
                      ),
                      const PopupMenuItem(value: 'revoke', child: Text('撤销授权')),
                      const PopupMenuItem(
                        value: 'delete',
                        child: Text('删除来源及派生资料'),
                      ),
                    ],
                  ),
          ),
        ),
    ],
  );
  String _status(String? value) => switch (value) {
    'accepted' => 'Host 已接收',
    'revoked' => '授权已撤销',
    'deleted' => 'Host 已删除',
    'conflict' => '授权存在冲突',
    'rejected' => 'Host 拒绝请求',
    'revoking' => '等待 Host 撤销',
    'deleting' => '等待 Host 删除',
    _ => '等待 Host 接收',
  };
}
