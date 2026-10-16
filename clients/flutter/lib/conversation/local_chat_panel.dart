import 'package:flutter/material.dart';
import '../agent_core/agent_core_host.dart';
import '../agent_core/model_client.dart';
import '../agent_core/model_settings.dart';
import '../agent_core/tool_registry.dart';
import 'dart:convert';

/// Also used by native task settings: one Dart source, projected to the host.
Future<void> showLocalModelSettings(
  BuildContext context,
  ModelSettings settings,
) async {
  final current = await settings.read();
  if (!context.mounted) return;
  final endpoint = TextEditingController(
    text: current?.endpoint ?? 'https://openrouter.ai/api/v1/chat/completions',
  );
  final model = TextEditingController(
    text: current?.model ?? 'openai/gpt-4.1-mini',
  );
  final key = TextEditingController();
  String? error;
  var saving = false;
  try {
    await showDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          title: const Text('本机模型服务'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('对话和任务所需数据将发给此服务。密钥仅保存在本机，不通过 Hub 同步。'),
                TextField(
                  controller: endpoint,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Chat Completions 地址',
                  ),
                ),
                TextField(
                  controller: model,
                  autocorrect: false,
                  decoration: const InputDecoration(labelText: '模型'),
                ),
                TextField(
                  controller: key,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: InputDecoration(
                    labelText: current == null ? 'API Key' : '密钥（留空保留）',
                  ),
                ),
                if (error != null) Text(error!),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(context),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: saving
                  ? null
                  : () async {
                      setState(() {
                        saving = true;
                        error = null;
                      });
                      try {
                        await settings.save(
                          endpoint: endpoint.text,
                          model: model.text,
                          key: key.text,
                        );
                        if (context.mounted) Navigator.pop(context);
                      } catch (failure) {
                        if (context.mounted) {
                          setState(() {
                            error = failure is AgentFailure
                                ? failure.code
                                : 'model_settings_failed';
                            saving = false;
                          });
                        }
                      }
                    },
              child: const Text('保存'),
            ),
          ],
        ),
      ),
    );
  } finally {
    endpoint.dispose();
    model.dispose();
    key.dispose();
  }
}

class LocalChatPanel extends StatefulWidget {
  const LocalChatPanel({
    super.key,
    required this.host,
    required this.conversationId,
    required this.computerConnected,
    this.computerPanel,
  });
  final AgentCoreHost host;
  final String conversationId;
  final bool computerConnected;
  final Widget? computerPanel;
  @override
  State<LocalChatPanel> createState() => _LocalChatPanelState();
}

class _LocalChatPanelState extends State<LocalChatPanel> {
  final input = TextEditingController();
  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  Future<bool> _approve(ApprovalOffer offer) async {
    if (!mounted) return false;
    return await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text('允许 ${offer.tool}？'),
            content: SingleChildScrollView(
              child: Text(
                '${const JsonEncoder.withIndent('  ').convert(offer.arguments)}\n批准仅对此次参数有效，两分钟后过期。',
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('拒绝'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('允许一次'),
              ),
            ],
          ),
        ) ??
        false;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.host,
    builder: (context, _) {
      final host = widget.host;
      final conversation = host.store.conversation(widget.conversationId);
      final local = conversation['backend'] == 'local';
      return Column(
        children: [
          Row(
            children: [
              const SizedBox(width: 12),
              DropdownButton<String>(
                value: conversation['backend'] as String,
                items: const [
                  DropdownMenuItem(value: 'local', child: Text('本机')),
                  DropdownMenuItem(value: 'computer', child: Text('电脑')),
                ],
                onChanged: host.busy
                    ? null
                    : (value) async {
                        if (value == null) return;
                        try {
                          await host.store.selectBackend(
                            widget.conversationId,
                            value,
                          );
                          if (mounted) setState(() {});
                        } catch (_) {
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('无法保存后端选择')),
                            );
                          }
                        }
                      },
              ),
              const Spacer(),
              IconButton(
                tooltip: '本机模型设置',
                icon: const Icon(Icons.settings_outlined),
                onPressed: host.busy
                    ? null
                    : () async {
                        try {
                          await showLocalModelSettings(context, host.settings);
                        } catch (_) {
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('无法读取模型设置')),
                            );
                          }
                        }
                      },
              ),
            ],
          ),
          if (!local)
            Expanded(
              child: widget.computerConnected && widget.computerPanel != null
                  ? widget.computerPanel!
                  : const Center(child: Text('电脑未连接，可切换到本机继续。')),
            ),
          if (local) ...[
            Expanded(
              child: ListView(
                children: [
                  for (final message in conversation['messages'] as List)
                    ListTile(
                      title: Text(message['content'] as String),
                      subtitle: Text(message['role'] as String),
                    ),
                  if (host.draft.isNotEmpty) ListTile(title: Text(host.draft)),
                ],
              ),
            ),
            if (host.error != null) Text(host.error!),
            SafeArea(
              top: false,
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: input,
                      enabled: !host.busy,
                      decoration: const InputDecoration(labelText: '消息'),
                    ),
                  ),
                  IconButton(
                    tooltip: host.busy ? '停止' : '发送',
                    icon: Icon(host.busy ? Icons.stop : Icons.send),
                    onPressed: () {
                      if (host.busy) {
                        host.cancel();
                        return;
                      }
                      final text = input.text;
                      input.clear();
                      host.send(widget.conversationId, text, approve: _approve);
                    },
                  ),
                ],
              ),
            ),
          ],
        ],
      );
    },
  );
}
