import 'package:flutter/material.dart';

import '../agent_core/model_presets.dart';
import '../agent_core/model_settings.dart';
import '../settings/model_settings_backend.dart';
import 'provider_setup_page.dart';
import '../agent_core/provider_credentials.dart';
import 'local_dialog.dart';

const _speechServices = [
  ('Groq', 'https://api.groq.com/openai/v1'),
  ('Together', 'https://api.together.ai/v1'),
  ('Mistral', 'https://api.mistral.ai/v1'),
  ('火山语音', 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'),
];

/// Reports saved presence only; a saved key has not been network-validated.
class ProviderCredentialStatus extends StatelessWidget {
  const ProviderCredentialStatus({
    super.key,
    required this.configured,
    this.language = 'zh',
  });
  final Future<bool> configured;
  final String language;

  @override
  Widget build(BuildContext context) => FutureBuilder<bool>(
    future: configured,
    builder: (context, snapshot) {
      String t(String zh, String en) => language == 'zh' ? zh : en;
      final state = snapshot.connectionState != ConnectionState.done
          ? t('正在读取…', 'Loading…')
          : snapshot.hasError
          ? t('无法读取', 'Unavailable')
          : snapshot.data != true
          ? t('未配置', 'Not configured')
          : t('已配置', 'Configured');
      return Text(
        t('API 密钥：$state', 'API key: $state'),
        style: Theme.of(context).textTheme.bodySmall,
      );
    },
  );
}

/// Editing credentials never changes the selected conversation model.
Future<String?> showProviderCredentials(
  BuildContext context,
  ProviderCredentials credentials, {
  String? endpoint,
  String? credentialId,
  ModelSettings? modelSettings,
  String language = 'zh',
  Future<void> Function(String credentialId)? onChanged,
}) async {
  if (!context.mounted) return null;
  if (endpoint != null) {
    final existing = await credentials.resolve(
      endpoint,
      credentialId: credentialId,
    );
    if (!context.mounted) return null;
    return _editCredential(
      context,
      credentials,
      existing: existing,
      endpoint: endpoint,
      language: language,
      onChanged: onChanged,
    );
  }
  final backend = _CredentialBackend(
    modelSettings ?? ModelSettings(storage: credentials.storage),
    credentials,
    onChanged,
  );
  final view = await backend.load();
  if (!context.mounted) return null;
  await showProviderSetupPage(
    context,
    backend,
    view,
    language: language,
    onManageCredentials: (context) async {
      await _showSpeechCredentials(
        context,
        credentials,
        language: language,
        onChanged: onChanged,
      );
    },
  );
  return null;
}

/// Speech APIs need not expose a chat model or support tool calling.
Future<String?> _showSpeechCredentials(
  BuildContext context,
  ProviderCredentials credentials, {
  required String language,
  Future<void> Function(String credentialId)? onChanged,
}) async {
  Future<List<ProviderCredential>> speechEntries() async =>
      (await credentials.list())
          .where(
            (entry) =>
                entry.endpoint.startsWith('wss:') ||
                entry.endpoint.startsWith('ws:') ||
                _speechServices.any((s) => s.$2 == entry.endpoint),
          )
          .toList();
  final entries = await speechEntries();
  if (!context.mounted) return null;
  String t(String zh, String en) => language == 'zh' ? zh : en;
  var current = entries;
  String? error;
  return showLocalDialog<String>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: Text(t('语音专用密钥', 'Speech-only credentials')),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  t(
                    '仅配置不支持对话模型测试的语音服务。对话服务密钥请返回「配置密钥」管理。',
                    'For speech services without chat model testing. Manage chat service keys in Configure keys.',
                  ),
                ),
                const SizedBox(height: 12),
                if (current.isEmpty)
                  Text(t('服务密钥：未配置', 'Provider credentials: Not configured')),
                for (final entry in current)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(entry.label),
                    subtitle: Text(t('已配置 · 点此修改', 'Configured · Tap to edit')),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () async {
                      try {
                        final id = await _editCredential(
                          context,
                          credentials,
                          existing: entry,
                          language: language,
                          onChanged: onChanged,
                        );
                        if (id == null || !context.mounted) return;
                        final next = await speechEntries();
                        if (context.mounted) setState(() => current = next);
                      } catch (_) {
                        if (context.mounted) {
                          setState(
                            () => error = t(
                              '无法读取服务配置，请重试。',
                              'Could not read provider settings. Try again.',
                            ),
                          );
                        }
                      }
                    },
                  ),
                TextButton.icon(
                  icon: const Icon(Icons.add),
                  label: Text(t('添加服务', 'Add provider')),
                  onPressed: () async {
                    try {
                      final id = await _editCredential(
                        context,
                        credentials,
                        language: language,
                        onChanged: onChanged,
                      );
                      if (id == null || !context.mounted) return;
                      final next = await speechEntries();
                      if (context.mounted) {
                        setState(() {
                          current = next;
                          error = null;
                        });
                      }
                    } catch (_) {
                      if (context.mounted) {
                        setState(
                          () => error = t(
                            '无法读取服务配置，请重试。',
                            'Could not read provider settings. Try again.',
                          ),
                        );
                      }
                    }
                  },
                ),
                if (error != null)
                  Text(
                    error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(t('完成', 'Done')),
          ),
        ],
      ),
    ),
  );
}

Future<String?> _editCredential(
  BuildContext context,
  ProviderCredentials credentials, {
  ProviderCredential? existing,
  String? endpoint,
  required String language,
  Future<void> Function(String credentialId)? onChanged,
}) async {
  String t(String zh, String en) => language == 'zh' ? zh : en;
  final fixed = endpoint != null || existing != null;
  final presets = [..._speechServices];
  final url = TextEditingController(
    text: endpoint ?? existing?.endpoint ?? presets.first.$2,
  );
  final key = TextEditingController();
  var selection = fixed ? url.text : presets.first.$2;
  var savedCredential = credentials.resolve(
    url.text,
    credentialId: existing?.id,
  );
  var saving = false;
  String? error;
  Future<String?> resolvedId(Future<ProviderCredential?> credential) async {
    try {
      return (await credential)?.id;
    } catch (_) {
      return null;
    }
  }

  try {
    return await showLocalDialog<String>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          title: Text(t('配置服务密钥', 'Configure provider key')),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (fixed)
                  Text(
                    existing?.label ??
                        ModelPreset.forEndpoint(url.text)?.label(language) ??
                        Uri.parse(url.text).host,
                  )
                else
                  DropdownButtonFormField<String>(
                    key: const ValueKey('credential.provider'),
                    initialValue: selection,
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: t('服务厂商', 'Provider'),
                    ),
                    items: [
                      for (final (name, address) in presets)
                        DropdownMenuItem(
                          value: address,
                          child: Text(name, overflow: TextOverflow.ellipsis),
                        ),
                      DropdownMenuItem(
                        value: 'custom',
                        child: Text(t('自定义服务', 'Custom provider')),
                      ),
                    ],
                    onChanged: saving
                        ? null
                        : (value) {
                            if (value == null) return;
                            setState(() {
                              selection = value;
                              url.text = value == 'custom' ? '' : value;
                              savedCredential = credentials.resolve(url.text);
                              key.clear();
                              error = null;
                            });
                          },
                  ),
                if (!fixed && selection == 'custom') ...[
                  const SizedBox(height: 12),
                  TextField(
                    controller: url,
                    key: const ValueKey('credential.endpoint'),
                    onChanged: (_) async {
                      final previous = savedCredential;
                      final next = credentials.resolve(url.text);
                      setState(() {
                        savedCredential = next;
                      });
                      // A typed key belongs to the credential resolved before
                      // the edit; keep it unless the URL moves to another one.
                      if (await resolvedId(previous) ==
                          await resolvedId(next)) {
                        return;
                      }
                      if (context.mounted) key.clear();
                    },
                    enabled: !saving,
                    autocorrect: false,
                    keyboardType: TextInputType.url,
                    decoration: InputDecoration(
                      labelText: t('服务地址', 'Service URL'),
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                ProviderCredentialStatus(
                  configured: savedCredential.then((value) => value != null),
                  language: language,
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: key,
                  enabled: !saving,
                  obscureText: true,
                  key: const ValueKey('credential.secret'),
                  autocorrect: false,
                  enableSuggestions: false,
                  enableIMEPersonalizedLearning: false,
                  decoration: InputDecoration(
                    labelText: t('API 密钥', 'API key'),
                    helperText: t(
                      '已保存的密钥不会回显；留空时保留此服务已配置的密钥',
                      'Saved keys stay hidden. Leave blank to keep this provider’s configured key.',
                    ),
                    helperMaxLines: 2,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  t(
                    '密钥保存在本机安全存储中，由这台设备上的所有 Space 共用。修改密钥会影响所有使用它的 Space。ChatGPT 登录不能代替语音服务所需的 API 密钥。',
                    'Credentials stay in secure storage on this device and are shared by all Spaces. Editing a key affects every Space using it. ChatGPT sign-in does not provide a voice API key.',
                  ),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(
                      error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: saving ? null : () => Navigator.pop(context),
              child: Text(t('取消', 'Cancel')),
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
                        final result = await credentials.save(
                          id: (await savedCredential)?.id,
                          endpoint: url.text,
                          key: key.text,
                        );
                        await onChanged?.call(result.id);
                        if (context.mounted) Navigator.pop(context, result.id);
                      } catch (_) {
                        if (context.mounted) {
                          setState(() {
                            saving = false;
                            error = t(
                              '未能应用配置，请检查服务地址和密钥后重试。',
                              'Could not apply settings. Check the service URL and key, then retry.',
                            );
                          });
                        }
                      }
                    },
              child: Text(saving ? t('正在保存…', 'Saving…') : t('保存', 'Save')),
            ),
          ],
        ),
      ),
    );
  } finally {
    url.dispose();
    key.dispose();
  }
}

/// Uses the shared key store and the caller's Space projection callback. Saving a key
/// can never select an API model or disable a ChatGPT account.
class _CredentialBackend extends LocalModelSettingsBackend {
  _CredentialBackend(super.settings, this.credentials, this.onChanged)
    : super(credentialsOnly: true);
  final ProviderCredentials credentials;
  final Future<void> Function(String)? onChanged;

  @override
  Future<void> saveCredential(ModelSettingsInput input) async {
    final existing = await credentials.resolve(
      input.endpoint,
      credentialId: ModelPreset.byId(input.providerId ?? '') == null
          ? input.providerId
          : null,
    );
    final saved = await credentials.save(
      id: existing?.id,
      endpoint: input.endpoint,
      key: input.newKey,
      protocol: input.protocol,
    );
    await onChanged?.call(saved.id);
  }

  @override
  Future<void> deleteProvider(String id) async {
    await credentials.delete(id);
    await onChanged?.call(id);
  }
}
