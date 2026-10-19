import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../agent_core/model_client.dart';
import '../agent_core/model_settings.dart';
import 'components.dart';
import 'local_dialog.dart';
import 'theme.dart';

enum _AccountNotice {
  operationFailed,
  settingsUnavailable,
  revocationUnconfirmed,
}

/// Account metadata is displayed here; credentials never enter widget state.
Future<void> showChatGptSettings(
  BuildContext context,
  ModelSettings settings,
) async {
  final accounts = settings.chatGpt;
  var data = await accounts.metadata();
  var catalog = <Map<String, String>>[];
  _AccountNotice? message;
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
            message =
                error is AgentFailure &&
                    error.code == 'chatgpt_settings_unavailable'
                ? _AccountNotice.settingsUnavailable
                : _AccountNotice.operationFailed;
          } finally {
            try {
              data = await accounts.metadata();
            } catch (_) {
              message = _AccountNotice.settingsUnavailable;
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
                  const Padding(
                    padding: EdgeInsets.only(bottom: 4),
                    child: Text(
                      '使用这台手机独立登录的 ChatGPT 账号。账号与密钥只保存在本机，不从电脑或 Hub 同步。',
                      style: TextStyle(
                        color: Nova.secondary,
                        fontSize: 13,
                        height: 1.5,
                      ),
                    ),
                  ),
                  if (list.isNotEmpty)
                    NovaSection(
                      header: '账号',
                      margin: const EdgeInsets.only(bottom: 10),
                      surface: Nova.sheetCell,
                      children: [
                        for (final account in list)
                          NovaTile(
                            surface: Nova.sheetCell,
                            leading: const NovaIconTile(
                              CupertinoIcons.person_fill,
                            ),
                            title: account['email'] as String? ?? 'ChatGPT 账号',
                            trailing: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                NovaStatusChip(
                                  account['signed_in'] != true
                                      ? '需要重新登录'
                                      : data['active'] == account['client_id']
                                      ? '当前账号'
                                      : '已保存',
                                  tone: account['signed_in'] != true
                                      ? NovaTone.warning
                                      : data['active'] == account['client_id']
                                      ? NovaTone.success
                                      : NovaTone.neutral,
                                ),
                                PopupMenuButton<String>(
                                  enabled: !busy,
                                  icon: const Icon(
                                    CupertinoIcons.ellipsis,
                                    size: 20,
                                    color: Nova.secondary,
                                  ),
                                  onSelected: (value) => run(() async {
                                    final id = account['client_id'] as String;
                                    catalog = [];
                                    if (value == 'logout') {
                                      final revoked = await accounts.signOut(
                                        id,
                                      );
                                      if (data['active'] == id) {
                                        await settings.clearNativeChatGpt();
                                      }
                                      if (!revoked) {
                                        message = _AccountNotice
                                            .revocationUnconfirmed;
                                      }
                                    } else if (value == 'signin' ||
                                        value == 'enable') {
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
                              ],
                            ),
                          ),
                      ],
                    ),
                  const SizedBox(height: 8),
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
                    if (catalog.isNotEmpty)
                      NovaSection(
                        header: '模型',
                        margin: const EdgeInsets.only(top: 8, bottom: 10),
                        surface: Nova.sheetCell,
                        children: [
                          for (final model in catalog)
                            NovaTile(
                              surface: Nova.sheetCell,
                              title: model['display_name']!,
                              subtitle: Text(model['slug']!),
                              trailing:
                                  list.any(
                                    (a) =>
                                        a['client_id'] == data['active'] &&
                                        a['model'] == model['slug'],
                                  )
                                  ? const Icon(
                                      CupertinoIcons.checkmark,
                                      size: 18,
                                      color: Nova.mint,
                                    )
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
                        ],
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
                    NovaNotice(
                      switch (message!) {
                        _AccountNotice.revocationUnconfirmed =>
                          '已在本机退出，远程撤销未确认。可在 ChatGPT 设置中断开应用。',
                        _AccountNotice.settingsUnavailable =>
                          '暂时无法读取账号信息，请稍后重试。',
                        _AccountNotice.operationFailed => '操作没有完成，请重试。',
                      },
                      tone: message == _AccountNotice.revocationUnconfirmed
                          ? NovaTone.warning
                          : NovaTone.danger,
                    ),
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
