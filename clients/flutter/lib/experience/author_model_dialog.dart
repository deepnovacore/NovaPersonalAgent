import 'package:flutter/material.dart';

import '../space/space_storage.dart';
import '../ui/local_dialog.dart';
import '../ui/theme.dart';
import 'experience_session.dart';

Future<({String? testerId})?> showAuthorModelDialog(
  BuildContext context, {
  required ExperienceSession session,
  required SpaceRecord space,
  required String language,
  required String? selected,
}) async {
  final code = TextEditingController();
  final saved = session.resumeInvite(scope: 'text');
  String t(String zh, String en) => language == 'zh' ? zh : en;
  var saving = false;
  String? error;
  try {
    return await showLocalDialog<({String? testerId})>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) {
          Future<void> save(String? testerId, {bool redeem = false}) async {
            if (saving) return;
            final input = code.text.trim();
            if (redeem && input.isEmpty) {
              update(() => error = t('请输入体验码', 'Enter an experience code.'));
              return;
            }
            update(() {
              saving = true;
              error = null;
            });
            try {
              final id = redeem ? await session.redeem(input) : testerId;
              await session.setAuthorEnrollment(space, id);
              if (context.mounted) Navigator.pop(context, (testerId: id));
            } catch (failure) {
              if (!context.mounted) return;
              final key = switch (failure) {
                ExperienceFailure(:final code) => code,
                _ => 'save_failed',
              };
              update(() {
                saving = false;
                error = switch (key) {
                  'invite_expired' => t('体验码已过期。', 'This code has expired.'),
                  'invalid_invite' || 'invalid_request' => t(
                    '体验码无效，请核对。',
                    'Check the experience code.',
                  ),
                  'enrollment_inactive' => t(
                    '体验资格已失效。',
                    'Experience access has expired.',
                  ),
                  'rate_limited' => t(
                    '操作太频繁，稍后再试。',
                    'Too many attempts. Try again shortly.',
                  ),
                  'unavailable' => t(
                    '连不上服务，请检查网络。',
                    'Check your network and try again.',
                  ),
                  _ => t('设置失败，请重试。', 'Could not update the model. Try again.'),
                };
              });
            }
          }

          return FutureBuilder<String?>(
            future: saved,
            builder: (context, snapshot) {
              final pending = snapshot.connectionState != ConnectionState.done;
              final existing = snapshot.data;
              final active = selected != null && selected == existing;
              return PopScope(
                canPop: !saving,
                child: AlertDialog(
                  scrollable: true,
                  title: Text(t('兑换体验码', 'Redeem experience code')),
                  content: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        active
                            ? t(
                                '当前 Space 正在使用作者提供的对话模型。',
                                'This Space is using the author-provided chat model.',
                              )
                            : t(
                                '兑换后即可使用作者提供的对话模型。',
                                'Redeem a code to use the author-provided chat model.',
                              ),
                      ),
                      if (!pending && existing == null)
                        TextField(
                          controller: code,
                          enabled: !saving,
                          autocorrect: false,
                          enableSuggestions: false,
                          maxLength: 128,
                          decoration: InputDecoration(
                            labelText: t('体验码', 'Experience code'),
                          ),
                          onSubmitted: (_) => save(null, redeem: true),
                        ),
                      if (pending || saving) const LinearProgressIndicator(),
                      if (error != null)
                        Text(error!, style: TextStyle(color: Nova.red)),
                    ],
                  ),
                  actions: [
                    TextButton(
                      onPressed: saving ? null : () => Navigator.pop(context),
                      child: Text(t('取消', 'Cancel')),
                    ),
                    if (selected != null)
                      TextButton(
                        onPressed: saving ? null : () => save(null),
                        child: Text(t('切回原模型', 'Use previous model')),
                      ),
                    if (!pending && !active)
                      FilledButton(
                        onPressed: saving
                            ? null
                            : () => save(existing, redeem: existing == null),
                        child: Text(
                          existing == null
                              ? t('兑换并启用', 'Redeem and enable')
                              : t('启用', 'Enable'),
                        ),
                      ),
                  ],
                ),
              );
            },
          );
        },
      ),
    );
  } finally {
    code.dispose();
  }
}
