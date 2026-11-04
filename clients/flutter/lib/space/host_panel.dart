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
  });
  final String? section;
  final SpaceClientState state;
  final Future<void> Function() onSync;
  final Future<void> Function(Uri uri)? openUrl;
  @override
  State<SpaceHostPanel> createState() => _SpaceHostPanelState();
}

class _SpaceHostPanelState extends State<SpaceHostPanel> {
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
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    return value == null || value.isEmpty ? null : value;
  }

  String _providerLabel(String name) =>
      const {
        'ARK_API_KEY': '火山方舟',
        'AUTOGLM_API_KEY': 'AutoGLM',
        'CODEX_API_KEY': 'Codex',
        'COMPATIBLE_ASR_API_KEY': '兼容语音识别服务',
        'COMPATIBLE_TTS_API_KEY': '兼容语音合成服务',
        'DASHSCOPE_API_KEY': '通义千问 / DashScope',
        'DEEPSEEK_API_KEY': 'DeepSeek',
        'DOUBAO_BIGMODEL_API_KEY': '豆包语音',
        'EMBEDDING_API_KEY': '向量模型服务',
        'GEMINI_API_KEY': 'Gemini',
        'OPENAI_API_KEY': 'OpenAI',
        'OPENAI_COMPATIBLE_API_KEY': 'OpenAI 兼容服务',
        'OPENROUTER_API_KEY': 'OpenRouter',
        'SELF_HOSTED_ASR_API_KEY': '自托管语音识别',
        'SELF_HOSTED_LLM_API_KEY': '自托管模型',
        'SELF_HOSTED_TTS_API_KEY': '自托管语音合成',
        'STEPFUN_API_KEY': '阶跃星辰 / StepFun',
      }[name] ??
      '其他模型服务';

  Future<void> _putSecret(String name) async {
    final secret = await _ask(
      '${_providerLabel(name)} API 密钥',
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
            header: 'Host 设置',
            footer: '修改将发送到 Host 执行，仅限本 Space 的所有者设备。',
            children: [
              _tile(
                '助手名称',
                '${identity['assistant_name'] ?? ''}',
                () async {
                  final v = await _ask(
                    '助手名称',
                    '${identity['assistant_name'] ?? ''}',
                  );
                  if (v != null) {
                    await _patch('identity.configure', {'assistant_name': v});
                  }
                },
                key: const ValueKey('host.assistant_name'),
              ),
              _tile(
                '你的称呼',
                '${identity['user_name'] ?? ''}',
                () async {
                  final v = await _ask(
                    '你的称呼',
                    '${identity['user_name'] ?? ''}',
                  );
                  if (v != null) {
                    await _patch('identity.configure', {'user_name': v});
                  }
                },
                key: const ValueKey('host.user_name'),
              ),
              if (soul['available'] == true)
                _tile('角色设定', '${soul['role'] ?? ''}', () async {
                  final v = await _ask(
                    '角色设定',
                    '${soul['role'] ?? ''}',
                    lines: 3,
                  );
                  if (v != null) {
                    await _patch('soul.set', {
                      'role': v,
                      'expected_version': soul['version'],
                    });
                  }
                }, key: const ValueKey('host.soul')),
              NovaTile(
                key: const ValueKey('host.discovery'),
                title: '主动发现',
                trailing: Switch(
                  value: discovery['discovery_enabled'] == true,
                  onChanged: (v) =>
                      _patch('discovery.configure', {'enabled': v}),
                ),
              ),
              NewsInterests(
                key: const ValueKey('host.news'),
                news: news,
                language: 'zh',
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
            header: 'API 密钥',
            footer: credentialsDamaged
                ? 'Host 上保存的密钥文件已损坏，本次启动已忽略；请重新输入需要的密钥。'
                : '密钥只发送给 Host，不会回显；写入后需重启 Host 生效，Host 环境变量中已设置的密钥优先。',
            children: [
              for (final c in credentials)
                NovaTile(
                  key: ValueKey('host.credential.${c['name']}'),
                  title: _providerLabel('${c['name']}'),
                  subtitle: Text(
                    c['configured'] == true
                        ? '已配置 · ${c['source'] == 'environment' ? '来自 Host 环境' : '来自 Space'} · ${c['fingerprint']}'
                        : '未配置',
                  ),
                  trailing: Wrap(
                    children: [
                      if (c['source'] == 'space')
                        IconButton(
                          key: ValueKey('host.credential.clear.${c['name']}'),
                          tooltip: '清除',
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
            header: 'Host 飞书',
            footer: '授权在 Host 上完成，手机不保存也不转交飞书令牌。',
            children: [
              NovaTile(
                key: const ValueKey('host.feishu.status'),
                title: connected
                    ? '已连接'
                    : unverified
                    ? '暂时无法验证登录'
                    : loginPending
                    ? '等待在授权页确认'
                    : '未连接',
                subtitle: Text(
                  unverified && feishu['error'] is String
                      ? feishu['error'] as String
                      : feishu['configured'] == true
                      ? '应用已配置'
                      : '尚未配置飞书应用',
                ),
              ),
              if (feishu['configured'] != true)
                NovaTile(
                  key: const ValueKey('host.feishu.app_start'),
                  title: '配置飞书应用',
                  onTap: () =>
                      _send('connector.feishu', {'action': 'app.start'}),
                ),
              if (setupUrl != null)
                NovaTile(
                  key: const ValueKey('host.feishu.app_open'),
                  title: '打开配置页面',
                  onTap: () => _open(setupUrl),
                ),
              if (feishu['configured'] == true && !connected && !unverified)
                NovaTile(
                  key: const ValueKey('host.feishu.login'),
                  title: loginPending ? '重新开始登录' : '登录飞书',
                  subtitle: loginPending
                      ? const Text('授权页过期或确认失败时使用，之前的授权链接会失效')
                      : null,
                  onTap: () => _send('connector.feishu', {'action': 'login'}),
                ),
              if (loginUrl != null && !connected)
                NovaTile(
                  key: const ValueKey('host.feishu.open'),
                  title: '打开授权页面',
                  onTap: () => _open(loginUrl),
                ),
              if (loginUrl != null && !connected)
                NovaTile(
                  key: const ValueKey('host.feishu.complete'),
                  title: '完成',
                  subtitle: const Text('在授权页确认后点此通知 Host'),
                  onTap: () =>
                      _send('connector.feishu', {'action': 'complete'}),
                ),
              if (connected || unverified)
                NovaTile(
                  key: const ValueKey('host.feishu.logout'),
                  title: '退出登录',
                  onTap: () => _send('connector.feishu', {'action': 'logout'}),
                ),
            ],
          ),
      ],
    );
  }
}
