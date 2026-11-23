import 'dart:async';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../ui/components.dart';
import '../ui/theme.dart';
import 'client_state.dart';
import 'space_dialog.dart';

/// Captured input and authorization are requests to Host, never a second local
/// profile producer. Pending source text remains durable until its Host receipt.
class SpaceSourcePanel extends StatefulWidget {
  const SpaceSourcePanel({
    super.key,
    required this.state,
    required this.onSync,
    this.language = 'zh',
  });
  final SpaceClientState state;
  final String language;
  final Future<void> Function() onSync;
  @override
  State<SpaceSourcePanel> createState() => _SpaceSourcePanelState();
}

class _SpaceSourcePanelState extends State<SpaceSourcePanel> {
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  Future<void> collect({Map<String, dynamic>? source}) async {
    final name = TextEditingController(
      text: source?['name'] as String? ?? t('手机输入', 'Phone input'),
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
          title: Text('向 Host 发送采集输入'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: name,
                    decoration: InputDecoration(
                      labelText: t('来源名称', 'Source name'),
                    ),
                    maxLength: 100,
                  ),
                  TextField(
                    controller: text,
                    decoration: InputDecoration(
                      labelText: t('你采集的内容', 'Content you collected'),
                    ),
                    minLines: 4,
                    maxLines: 8,
                    maxLength: 16000,
                  ),
                  Text(
                    currentProvider == null
                        ? t(
                            'Host 尚未配置模型：可上传，不会进行模型处理。',
                            'The host has no model configured: content can be uploaded but will not be processed by a model.',
                          )
                        : t(
                            'Host 模型：${currentProvider['label']}\n授权仅限当前配置，Host 更换模型需重新授权。',
                            'Host model: ${currentProvider['label']}\nAuthorization covers this configuration only; a model change on the host needs new authorization.',
                          ),
                  ),
                  CheckboxListTile(
                    value: upload,
                    title: Text('允许将这份内容发送并保存在 Host'),
                    onChanged: (value) =>
                        setDialog(() => upload = value ?? false),
                  ),
                  CheckboxListTile(
                    value: processing,
                    title: Text('允许 Host 使用模型处理这份内容'),
                    subtitle: Text('不勾选时仅上传，不用于模型推断个人资料。'),
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
              child: Text('取消'),
            ),
            FilledButton(
              onPressed: upload ? () => Navigator.pop(context, true) : null,
              child: Text('授权并发送'),
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
        title: Text('向 Host 纠正个人资料'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            DropdownButtonFormField<String>(
              initialValue: key,
              items: [
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
              decoration: InputDecoration(
                labelText: t('正确内容', 'Correct content'),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text('发送纠正'),
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
        title: Text(
          delete
              ? t('删除采集来源？', 'Delete this source?')
              : t('撤销采集授权？', 'Revoke this source’s authorization?'),
        ),
        content: Text(
          delete
              ? t(
                  '将请求 Host 删除这个来源及由它派生的资料。处理结果以 Host 回执为准。',
                  'Asks the host to delete this source and the data derived from it. The host’s receipt is authoritative.',
                )
              : t(
                  '将禁止 Host 继续上传和处理这个来源。Host 离线时会等待同步；已发送内容在撤销请求生效前仍可能被处理。',
                  'Stops the host from uploading and processing this source. While the host is offline the request waits to sync; content already sent may still be processed until it takes effect.',
                ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text('确认'),
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
      NovaSection(
        header: t('手机采集与授权', 'Phone input & permissions'),
        footer: t(
          '由你选择内容并授权 Host 处理。此设备不运行个人资料推断。',
          'You choose content and authorize the host to process it. This device does not infer your profile.',
        ),
        children: [
          _processingSummary(),
          NovaTile(
            title: t('发送采集输入', 'Send input'),
            leading: const NovaIconTile(CupertinoIcons.doc_text),
            trailing: const CupertinoListTileChevron(),
            onTap: collect,
          ),
          NovaTile(
            title: t('纠正个人资料', 'Correct profile'),
            leading: const NovaIconTile(CupertinoIcons.person_crop_circle),
            trailing: const CupertinoListTileChevron(),
            onTap: correction,
          ),
        ],
      ),
      if (widget.state.clientSources.isNotEmpty)
        NovaSection(
          header: t('已授权来源', 'Authorized sources'),
          children: [
            for (final source in widget.state.clientSources.values)
              NovaTile(
                title: source['name'] as String? ?? t('手机输入', 'Phone input'),
                subtitle: Text(
                  '${_status(source['status'] as String?)} · ${source['allow_processing'] == true ? t('允许模型处理', 'Model processing allowed') : t('禁止模型处理', 'Model processing not allowed')}${source['error'] == null ? '' : ' · ${source['error']}'}',
                ),
                trailing: source['status'] == 'deleted'
                    ? null
                    : PopupMenuButton<String>(
                        icon: const Icon(
                          CupertinoIcons.ellipsis,
                          size: 20,
                          color: Nova.secondary,
                        ),
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
                          const PopupMenuItem(
                            value: 'revoke',
                            child: Text('撤销授权'),
                          ),
                          const PopupMenuItem(
                            value: 'delete',
                            child: Text('删除来源及派生资料'),
                          ),
                        ],
                      ),
              ),
          ],
        ),
    ],
  );

  Widget _processingSummary() {
    // Summary of the whole Space; per-source receipts are listed separately.
    final processing = widget.state.snapshot['source_processing'];
    final hasStatus = processing is Map;
    final status = hasStatus ? processing['status'] : null;
    final needsUpdate = hasStatus && processing['needs_update'] == true;
    final title = !hasStatus
        ? t('等待 Host 提供处理状态', 'Waiting for the host’s processing status')
        : switch (status) {
            'working' => t(
              'Host 正在处理采集内容',
              'The host is processing collected content',
            ),
            'ready' =>
              needsUpdate
                  ? t('Host 已完成上次处理', 'The host finished the previous run')
                  : t('Host 已完成处理', 'The host finished processing'),
            'failed' => t(
              'Host 处理失败，请检查 Host',
              'Host processing failed; check the host',
            ),
            _ => t('等待 Host 处理', 'Waiting for the host to process'),
          };
    return NovaTile(
      title: t('Host 处理汇总', 'Host processing summary'),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title),
          if (needsUpdate) Text('有新内容等待更新'),
          if (!widget.state.hostOnline)
            Text(
              hasStatus
                  ? t(
                      'Host 不在线，显示上次处理状态',
                      'Host offline; showing the last processing status',
                    )
                  : t(
                      'Host 不在线，等待获取处理状态',
                      'Host offline; waiting for processing status',
                    ),
            ),
        ],
      ),
    );
  }

  String _status(String? value) => switch (value) {
    'accepted' => t('Host 已收妥', 'Received by host'),
    'revoked' => t('授权已撤销', 'Authorization revoked'),
    'deleted' => t('Host 已删除', 'Deleted by host'),
    'conflict' => t('授权存在冲突', 'Authorization conflict'),
    'rejected' => t('Host 拒绝请求', 'Host rejected the request'),
    'revoking' => t('等待 Host 撤销', 'Waiting for the host to revoke'),
    'deleting' => t('等待 Host 删除', 'Waiting for the host to delete'),
    _ => t('等待 Host 接收', 'Waiting for the host to receive'),
  };
}
