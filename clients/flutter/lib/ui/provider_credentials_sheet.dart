import 'package:flutter/material.dart';

import '../agent_core/model_presets.dart';
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
  String language = 'zh',
  Future<void> Function(String credentialId)? onChanged,
}) async {
  final entries = await credentials.list();
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
  String t(String zh, String en) => language == 'zh' ? zh : en;
  var current = entries;
  String? error;
  return showLocalDialog<String>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: Text(t('模型服务密钥', 'Provider credentials')),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  t(
                    '在这里统一配置对话和语音服务的密钥。配置其他服务不会切换当前对话模型。',
                    'Manage credentials for chat and voice here. Configuring another service keeps your current chat model.',
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
                        final next = await credentials.list();
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
                      final next = await credentials.list();
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
  final presets = [
    for (final p in modelPresets) (p.label(language), p.endpoint),
    ..._speechServices,
  ];
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
                    '密钥仅保存在当前 Space 的本机安全存储中。ChatGPT 登录不能代替语音服务所需的 API 密钥。',
                    'Credentials stay in this Space’s secure storage on this device. ChatGPT sign-in does not provide a voice API key.',
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
