import 'package:flutter/material.dart';
import '../agent_core/model_client.dart';
import '../agent_core/model_settings.dart';
import 'local_dialog.dart';

/// Account metadata is displayed here; credentials never enter widget state.
Future<void> showChatGptSettings(
  BuildContext context,
  ModelSettings settings,
) async {
  final accounts = settings.chatGpt;
  var data = await accounts.metadata();
  var catalog = <Map<String, String>>[];
  String? message;
  var busy = false;
  if (!context.mounted) return;
  await showLocalDialog<void>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) {
        Future<void> run(Future<void> Function() operation) async {
          setState(() {
            busy = true;
            message = null;
          });
          try {
            await operation();
          } catch (error) {
            message = error is AgentFailure
                ? error.code
                : 'chatgpt_operation_failed';
          } finally {
            try {
              data = await accounts.metadata();
            } catch (_) {
              message = 'chatgpt_settings_unavailable';
            }
            if (context.mounted) {
              setState(() {
                busy = false;
              });
            }
          }
        }

        final list = data['accounts'] as List;
        return AlertDialog(
          title: const Text('ChatGPT'),
          content: SizedBox(
            width: 400,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '使用这台手机独立登录的 ChatGPT 账号。账号与密钥只保存在本机，不从电脑或 Hub 同步。',
                  ),
                  const SizedBox(height: 12),
                  for (final account in list)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(account['email'] as String? ?? 'ChatGPT'),
                      subtitle: Text(
                        '${account['client_id']}\n${account['signed_in'] != true
                            ? '需要重新登录'
                            : data['active'] == account['client_id']
                            ? '当前账号'
                            : '已保存'}',
                      ),
                      trailing: PopupMenuButton<String>(
                        enabled: !busy,
                        onSelected: (value) => run(() async {
                          final id = account['client_id'] as String;
                          catalog = [];
                          if (value == 'logout') {
                            final revoked = await accounts.signOut(id);
                            if (data['active'] == id) {
                              await settings.clearNativeChatGpt();
                            }
                            if (!revoked) {
                              message = '已在本机退出，远程撤销未确认。可在 ChatGPT 设置中断开应用。';
                            }
                          } else if (value == 'signin' || value == 'enable') {
                            await accounts.signIn(
                              clientId: id,
                              enablePlan: value == 'enable',
                            );
                            await settings.clearNativeChatGpt();
                            catalog = [];
                          } else {
                            await settings.clearNativeChatGpt();
                            await accounts.select(id);
                            catalog = await accounts.models();
                          }
                        }),
                        itemBuilder: (_) => [
                          if (account['signed_in'] == true)
                            const PopupMenuItem(
                              value: 'select',
                              child: Text('使用此账号'),
                            ),
                          const PopupMenuItem(
                            value: 'signin',
                            child: Text('重新登录'),
                          ),
                          const PopupMenuItem(
                            value: 'enable',
                            child: Text('启用 ChatGPT 方案用量'),
                          ),
                          if (account['signed_in'] == true)
                            const PopupMenuItem(
                              value: 'logout',
                              child: Text('退出此账号'),
                            ),
                        ],
                      ),
                    ),
                  FilledButton(
                    onPressed: busy
                        ? null
                        : () => run(() async {
                            catalog = [];
                            await accounts.signIn();
                            await settings.clearNativeChatGpt();
                            catalog = await accounts.models();
                          }),
                    child: const Text('Continue with ChatGPT'),
                  ),
                  if (data['active'] != null) ...[
                    TextButton(
                      onPressed: busy
                          ? null
                          : () => run(() async {
                              catalog = await accounts.models();
                            }),
                      child: const Text('刷新可用模型'),
                    ),
                    for (final model in catalog)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(model['display_name']!),
                        subtitle: Text(model['slug']!),
                        trailing:
                            list.any(
                              (a) =>
                                  a['client_id'] == data['active'] &&
                                  a['model'] == model['slug'],
                            )
                            ? const Icon(Icons.check)
                            : null,
                        onTap: busy
                            ? null
                            : () => run(() async {
                                await accounts.select(
                                  data['active'] as String,
                                  model: model['slug'],
                                );
                                await settings.read();
                              }),
                      ),
                    TextButton(
                      onPressed: busy
                          ? null
                          : () => run(() async {
                              await settings.useApiKey();
                            }),
                      child: const Text('使用 API Key 设置'),
                    ),
                  ],
                  if (busy) ...[
                    const LinearProgressIndicator(),
                    TextButton(
                      onPressed: accounts.cancelSignIn,
                      child: const Text('取消登录'),
                    ),
                  ],
                  if (message != null)
                    Text(message!, style: const TextStyle(color: Colors.red)),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: busy ? null : () => Navigator.pop(context),
              child: const Text('完成'),
            ),
          ],
        );
      },
    ),
  );
}
