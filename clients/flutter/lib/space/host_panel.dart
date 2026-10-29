import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../agent_core/model_presets.dart';
import '../agent_core/provider_credentials.dart';
import '../connectors/feishu/browser.dart';
import '../ui/components.dart';
import 'client_state.dart';
import 'space_dialog.dart';

/// Environment variable per provider preset, for the explicit "use this phone's key" shortcut.
const hostCredentialForPreset = {
  'openai': 'OPENAI_API_KEY',
  'openrouter': 'OPENROUTER_API_KEY',
  'gemini': 'GEMINI_API_KEY',
  'deepseek': 'DEEPSEEK_API_KEY',
  'qwen': 'DASHSCOPE_API_KEY',
  'ark': 'ARK_API_KEY',
};

/// Owner-only Host administration. Every edit is a durable intent; Host decides, and values are never read back.
class SpaceHostPanel extends StatefulWidget {
  const SpaceHostPanel({
    super.key,
    required this.state,
    required this.onSync,
    this.credentials,
    this.openUrl,
  });
  final SpaceClientState state;
  final Future<void> Function() onSync;
  final ProviderCredentials? credentials;
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

  Future<void> _putSecret(String name, {String? value}) async {
    final secret = value ?? await _ask('$name（保存到 Host）', '', secret: true);
    if (secret == null) return;
    await _send('secret.put', {'name': name, 'value': secret});
  }

  Future<void> _usePhoneKey(String name) async {
    final entries = await widget.credentials?.list() ?? const [];
    for (final entry in entries) {
      final id = ModelPreset.forEndpoint(entry.endpoint)?.id;
      if (id != null && hostCredentialForPreset[id] == name) {
        await _putSecret(name, value: entry.key);
        return;
      }
    }
    if (mounted) {
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('此手机没有保存匹配的密钥')));
    }
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
    final credentials = (snapshot['host_credentials'] as List? ?? [])
        .whereType<Map>()
        .map((v) => Map<String, dynamic>.from(v))
        .toList();
    final connected = feishu['connected'] == true;
    final setupUrl = setup['verification_url'] as String?;
    final loginUrl = feishu['verification_url'] as String?;
    return Column(
      children: [
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
                  await _patch('identity.configure', {
                    'assistant_name': v,
                    'user_name': identity['user_name'] ?? '',
                  });
                }
              },
              key: const ValueKey('host.assistant_name'),
            ),
            _tile(
              '你的称呼',
              '${identity['user_name'] ?? ''}',
              () async {
                final v = await _ask('你的称呼', '${identity['user_name'] ?? ''}');
                if (v != null) {
                  await _patch('identity.configure', {
                    'assistant_name': identity['assistant_name'] ?? 'nova',
                    'user_name': v,
                  });
                }
              },
              key: const ValueKey('host.user_name'),
            ),
            if (soul['available'] == true)
              _tile('角色设定', '${soul['role'] ?? ''}', () async {
                final v = await _ask('角色设定', '${soul['role'] ?? ''}', lines: 3);
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
                onChanged: (v) => _patch('discovery.configure', {'enabled': v}),
              ),
            ),
            _tile(
              '关注的资讯主题',
              (news['interests'] as List? ?? []).join('、'),
              () async {
                final v = await _ask(
                  '资讯主题（用逗号分隔，最多 8 个）',
                  (news['interests'] as List? ?? []).join(','),
                );
                if (v == null) return;
                final interests = v
                    .split(RegExp(r'[,，、]'))
                    .map((e) => e.trim())
                    .where((e) => e.isNotEmpty)
                    .take(8)
                    .toList();
                await _patch('news.configure', {
                  'enabled': interests.isNotEmpty,
                  'explore': news['explore'] ?? true,
                  'interests': interests,
                  'expected_version': news['profile_version'],
                });
              },
              key: const ValueKey('host.news'),
            ),
          ],
        ),
        NovaSection(
          header: 'Host 模型密钥',
          footer: '密钥只发送给 Host，不会回显；写入后需重启 Host 生效，Host 环境变量中已设置的密钥优先。',
          children: [
            for (final c in credentials)
              NovaTile(
                key: ValueKey('host.credential.${c['name']}'),
                title: '${c['name']}',
                subtitle: Text(
                  c['configured'] == true
                      ? '已配置 · ${c['source'] == 'environment' ? '来自 Host 环境' : '来自 Space'} · ${c['fingerprint']}'
                      : '未配置',
                ),
                trailing: Wrap(
                  children: [
                    if (hostCredentialForPreset.containsValue(c['name']))
                      IconButton(
                        key: ValueKey('host.credential.phone.${c['name']}'),
                        tooltip: '使用此手机已保存的密钥',
                        icon: const Icon(CupertinoIcons.device_phone_portrait),
                        onPressed: () => _usePhoneKey('${c['name']}'),
                      ),
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
        NovaSection(
          header: 'Host 飞书',
          footer: '授权在 Host 上完成，手机不保存也不转交飞书令牌。',
          children: [
            NovaTile(
              key: const ValueKey('host.feishu.status'),
              title: connected ? '已连接' : '未连接',
              subtitle: Text(
                feishu['configured'] == true ? '应用已配置' : '尚未配置飞书应用',
              ),
            ),
            if (feishu['configured'] != true)
              NovaTile(
                key: const ValueKey('host.feishu.app_start'),
                title: '配置飞书应用',
                onTap: () => _send('connector.feishu', {'action': 'app.start'}),
              ),
            if (setupUrl != null)
              NovaTile(
                key: const ValueKey('host.feishu.app_open'),
                title: '打开配置页面',
                onTap: () => _open(setupUrl),
              ),
            if (feishu['configured'] == true && !connected)
              NovaTile(
                key: const ValueKey('host.feishu.login'),
                title: '登录飞书',
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
                onTap: () => _send('connector.feishu', {'action': 'complete'}),
              ),
            if (connected)
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
