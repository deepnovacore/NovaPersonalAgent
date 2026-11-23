import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../connectors/feishu/browser.dart';
import '../ui/components.dart';
import '../ui/news_interests.dart';
import 'client_state.dart';
import 'space_dialog.dart';

/// A conflicted settings edit retried against the latest Host settings: Host
/// checks the version inside params, not the intent's base_version.
Map<String, dynamic> refreshSettingsPatch(
  Map<String, dynamic> input,
  Map<String, dynamic> snapshot,
) {
  final params = Map<String, dynamic>.from(input['params'] as Map? ?? {});
  if (!params.containsKey('expected_version')) return input;
  final settings = snapshot['host_settings'] as Map? ?? const {};
  final version = switch (input['method']) {
    'soul.set' => (settings['soul'] as Map?)?['version'],
    'models.configure' => (settings['models'] as Map?)?['version'],
    'news.configure' => (settings['news'] as Map?)?['profile_version'],
    _ => params['expected_version'],
  };
  return {
    ...input,
    'params': {...params, 'expected_version': version},
  };
}

/// Owner-only Host administration. Every edit is a durable intent; Host decides, and values are never read back.
class SpaceHostPanel extends StatefulWidget {
  const SpaceHostPanel({
    super.key,
    required this.state,
    required this.onSync,
    this.openUrl,
    this.section,
    this.language = 'zh',
  });
  final String? section;
  final String language;
  final SpaceClientState state;
  final Future<void> Function() onSync;
  final Future<void> Function(Uri uri)? openUrl;
  @override
  State<SpaceHostPanel> createState() => _SpaceHostPanelState();
}

class _SpaceHostPanelState extends State<SpaceHostPanel> {
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  Map<String, dynamic> _map(Object? v) =>
      v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
  Future<void> _send(String kind, Map<String, dynamic> input) async {
    await widget.state.enqueue(kind, input);
    await widget.onSync();
  }

  Future<void> _patch(String method, Map<String, dynamic> params) =>
      _send('settings.patch', {'method': method, 'params': params});

  Future<String?> _ask(
    String title,
    String initial, {
    bool secret = false,
    int lines = 1,
  }) async {
    final controller = TextEditingController(text: initial);
    final value = await showSpaceDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          obscureText: secret,
          autocorrect: !secret,
          enableSuggestions: !secret,
          minLines: lines,
          maxLines: secret ? 1 : lines + 3,
          autofocus: true,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(t('取消', 'Cancel')),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: Text(t('保存', 'Save')),
          ),
        ],
      ),
    );
    return value == null || value.isEmpty ? null : value;
  }

  String _providerLabel(String name) =>
      {
        'ARK_API_KEY': t('火山方舟', 'Volcano Ark'),
        'CODEX_API_KEY': 'Codex',
        'COMPATIBLE_ASR_API_KEY': t(
          '兼容语音识别服务',
          'Compatible speech recognition',
        ),
        'COMPATIBLE_TTS_API_KEY': t('兼容语音合成服务', 'Compatible speech synthesis'),
        'DASHSCOPE_API_KEY': t('通义千问 / DashScope', 'Qwen / DashScope'),
        'DEEPSEEK_API_KEY': 'DeepSeek',
        'DOUBAO_BIGMODEL_API_KEY': t('豆包语音', 'Doubao Speech'),
        'EMBEDDING_API_KEY': t('向量模型服务', 'Embedding model service'),
        'GEMINI_API_KEY': 'Gemini',
        'OPENAI_API_KEY': 'OpenAI',
        'OPENAI_COMPATIBLE_API_KEY': t(
          'OpenAI 兼容服务',
          'OpenAI-compatible service',
        ),
        'OPENROUTER_API_KEY': 'OpenRouter',
        'SELF_HOSTED_ASR_API_KEY': t(
          '自托管语音识别',
          'Self-hosted speech recognition',
        ),
        'SELF_HOSTED_LLM_API_KEY': t('自托管模型', 'Self-hosted model'),
        'SELF_HOSTED_TTS_API_KEY': t('自托管语音合成', 'Self-hosted speech synthesis'),
        'STEPFUN_API_KEY': t('阶跃星辰 / StepFun', 'StepFun'),
      }[name] ??
      t('其他模型服务', 'Other model service');

  Future<void> _putSecret(String name) async {
    final secret = await _ask(
      t('${_providerLabel(name)} API 密钥', '${_providerLabel(name)} API key'),
      '',
      secret: true,
    );
    if (secret == null) return;
    await _send('secret.put', {'name': name, 'value': secret});
  }

  Future<void> _open(String? url) async {
    final uri = url == null ? null : Uri.tryParse(url);
    if (uri == null) return;
    await (widget.openUrl ?? openFeishuBrowser)(uri);
  }

  Widget _tile(String title, String subtitle, VoidCallback onTap, {Key? key}) =>
      NovaTile(
        key: key,
        title: title,
        subtitle: Text(subtitle, maxLines: 2),
        trailing: const CupertinoListTileChevron(),
        onTap: onTap,
      );

  @override
  Widget build(BuildContext context) {
    final snapshot = widget.state.snapshot;
    if (snapshot['owner'] != true) return const SizedBox.shrink();
    final settings = _map(snapshot['host_settings']);
    final identity = _map(settings['identity']);
    final soul = _map(settings['soul']);
    final discovery = _map(settings['discovery']);
    final news = _map(settings['news']);
    final feishu = _map(snapshot['host_feishu']);
    final setup = _map(feishu['app_setup']);
    final credentialView = _map(snapshot['host_credentials']);
    final credentials = (credentialView['credentials'] as List? ?? [])
        .whereType<Map>()
        .map((v) => Map<String, dynamic>.from(v))
        .toList();
    final credentialsDamaged = credentialView['damaged'] == true;
    final connected = feishu['connected'] == true;
    final unverified = !connected && feishu['unverified'] == true;
    final setupUrl = setup['verification_url'] as String?;
    final loginUrl = feishu['verification_url'] as String?;
    // A new login replaces the code the browser is confirming, so while one is pending
    // it is offered only as an explicit restart for an expired or failed link.
    final loginPending =
        !connected && (feishu['login_pending'] == true || loginUrl != null);
    return Column(
      children: [
        if (widget.section == null || widget.section == 'assistant')
          NovaSection(
            header: t('Host 设置', 'Host settings'),
            footer: t(
              '修改将发送到 Host 执行，仅限本 Space 的所有者设备。',
              'Changes are sent to the host to apply, and only the Space owner’s device can make them.',
            ),
            children: [
              _tile(
                t('助手名称', 'Assistant name'),
                '${identity['assistant_name'] ?? ''}',
                () async {
                  final v = await _ask(
                    t('助手名称', 'Assistant name'),
                    '${identity['assistant_name'] ?? ''}',
                  );
                  if (v != null) {
                    await _patch('identity.configure', {'assistant_name': v});
                  }
                },
                key: const ValueKey('host.assistant_name'),
              ),
              _tile(
                t('你的称呼', 'What to call you'),
                '${identity['user_name'] ?? ''}',
                () async {
                  final v = await _ask(
                    t('你的称呼', 'What to call you'),
                    '${identity['user_name'] ?? ''}',
                  );
                  if (v != null) {
                    await _patch('identity.configure', {'user_name': v});
                  }
                },
                key: const ValueKey('host.user_name'),
              ),
              if (soul['available'] == true)
                _tile(
                  t('角色设定', 'Role'),
                  '${soul['role'] ?? ''}',
                  () async {
                    final v = await _ask(
                      t('角色设定', 'Role'),
                      '${soul['role'] ?? ''}',
                      lines: 3,
                    );
                    if (v != null) {
                      await _patch('soul.set', {
                        'role': v,
                        'expected_version': soul['version'],
                      });
                    }
                  },
                  key: const ValueKey('host.soul'),
                ),
              NovaTile(
                key: const ValueKey('host.discovery'),
                title: t('主动发现', 'Proactive discovery'),
                trailing: Switch(
                  value: discovery['discovery_enabled'] == true,
                  onChanged: (v) =>
                      _patch('discovery.configure', {'enabled': v}),
                ),
              ),
              NewsInterests(
                key: const ValueKey('host.news'),
                news: news,
                language: widget.language,
                configure: (interests) => _patch('news.configure', {
                  'enabled': news['enabled'] ?? true,
                  'explore': news['explore'] ?? true,
                  'interests': interests,
                  'expected_version': news['profile_version'],
                }),
              ),
            ],
          ),
        if (widget.section == null || widget.section == 'credentials')
          NovaSection(
            header: t('API 密钥', 'API keys'),
            footer: credentialsDamaged
                ? t(
                    'Host 上保存的密钥文件已损坏，本次启动已忽略；请重新输入需要的密钥。',
                    'The key file saved on the host is damaged and was ignored at this start. Enter the keys you need again.',
                  )
                : t(
                    '密钥只发送给 Host，不会回显；写入后需重启 Host 生效，Host 环境变量中已设置的密钥优先。',
                    'Keys are sent only to the host and never shown again. Restart the host after saving; keys already set in the host’s environment take precedence.',
                  ),
            children: [
              for (final c in credentials)
                NovaTile(
                  key: ValueKey('host.credential.${c['name']}'),
                  title: _providerLabel('${c['name']}'),
                  subtitle: Text(
                    c['configured'] == true
                        ? '${t('已配置', 'Configured')} · ${c['source'] == 'environment' ? t('来自 Host 环境', 'from the host environment') : t('来自 Space', 'from the Space')} · ${c['fingerprint']}'
                        : t('未配置', 'Not configured'),
                  ),
                  trailing: Wrap(
                    children: [
                      if (c['source'] == 'space')
                        IconButton(
                          key: ValueKey('host.credential.clear.${c['name']}'),
                          tooltip: t('清除', 'Clear'),
                          icon: const Icon(CupertinoIcons.delete),
                          onPressed: () =>
                              _send('secret.clear', {'name': c['name']}),
                        ),
                    ],
                  ),
                  onTap: () => _putSecret('${c['name']}'),
                ),
            ],
          ),
        if (widget.section == null || widget.section == 'feishu')
          NovaSection(
            header: t('Host 飞书', 'Host Feishu'),
            footer: t(
              '授权在 Host 上完成，手机不保存也不转交飞书令牌。',
              'Authorization happens on the host; this phone never stores or forwards Feishu tokens.',
            ),
            children: [
              NovaTile(
                key: const ValueKey('host.feishu.status'),
                title: connected
                    ? t('已连接', 'Connected')
                    : unverified
                    ? t('暂时无法验证登录', 'Unable to verify sign-in for now')
                    : loginPending
                    ? t(
                        '等待在授权页确认',
                        'Waiting for confirmation on the authorization page',
                      )
                    : t('未连接', 'Not connected'),
                subtitle: Text(
                  unverified && feishu['error'] is String
                      ? feishu['error'] as String
                      : feishu['configured'] == true
                      ? t('应用已配置', 'App configured')
                      : t('尚未配置飞书应用', 'Feishu app not configured yet'),
                ),
              ),
              if (feishu['configured'] != true)
                NovaTile(
                  key: const ValueKey('host.feishu.app_start'),
                  title: t('配置飞书应用', 'Set up Feishu app'),
                  onTap: () =>
                      _send('connector.feishu', {'action': 'app.start'}),
                ),
              if (setupUrl != null)
                NovaTile(
                  key: const ValueKey('host.feishu.app_open'),
                  title: t('打开配置页面', 'Open setup page'),
                  onTap: () => _open(setupUrl),
                ),
              if (feishu['configured'] == true && !connected && !unverified)
                NovaTile(
                  key: const ValueKey('host.feishu.login'),
                  title: loginPending
                      ? t('重新开始登录', 'Restart sign-in')
                      : t('登录飞书', 'Sign in to Feishu'),
                  subtitle: loginPending
                      ? Text(
                          t(
                            '授权页过期或确认失败时使用，之前的授权链接会失效',
                            'Use this if the authorization page expired or confirmation failed; the previous link stops working.',
                          ),
                        )
                      : null,
                  onTap: () => _send('connector.feishu', {'action': 'login'}),
                ),
              if (loginUrl != null && !connected)
                NovaTile(
                  key: const ValueKey('host.feishu.open'),
                  title: t('打开授权页面', 'Open authorization page'),
                  onTap: () => _open(loginUrl),
                ),
              if (loginUrl != null && !connected)
                NovaTile(
                  key: const ValueKey('host.feishu.complete'),
                  title: t('完成', 'Done'),
                  subtitle: Text(
                    t(
                      '在授权页确认后点此通知 Host',
                      'Tap after confirming on the authorization page to notify the host',
                    ),
                  ),
                  onTap: () =>
                      _send('connector.feishu', {'action': 'complete'}),
                ),
              if (connected || unverified)
                NovaTile(
                  key: const ValueKey('host.feishu.logout'),
                  title: t('退出登录', 'Sign out'),
                  onTap: () => _send('connector.feishu', {'action': 'logout'}),
                ),
            ],
          ),
      ],
    );
  }
}
