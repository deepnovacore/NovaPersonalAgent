import 'package:flutter/material.dart';

import '../ui/local_dialog.dart';
import '../ui/theme.dart';
import 'experience_session.dart';

enum _CodeStatus { needsCode, active, unavailable }

Future<bool> showExperienceCodeDialog(
  BuildContext context, {
  required ExperienceSession session,
  required String language,
}) async {
  final code = TextEditingController();
  Future<_CodeStatus> checkAccess() async {
    try {
      return await session.resumeInvite() == null
          ? _CodeStatus.needsCode
          : _CodeStatus.active;
    } catch (_) {
      return _CodeStatus.unavailable;
    }
  }

  var status = checkAccess();
  String t(String zh, String en) => language == 'zh' ? zh : en;
  var saving = false;
  String? error;
  try {
    return await showLocalDialog<bool>(
          context: context,
          builder: (context) => StatefulBuilder(
            builder: (context, update) {
              Future<void> redeem() async {
                if (saving) return;
                final input = code.text.trim();
                if (input.isEmpty) {
                  update(
                    () => error = t('请输入体验码。', 'Enter an experience code.'),
                  );
                  return;
                }
                update(() {
                  saving = true;
                  error = null;
                });
                try {
                  await session.redeem(input);
                  if (context.mounted) Navigator.pop(context, true);
                } catch (failure) {
                  if (!context.mounted) return;
                  update(() {
                    saving = false;
                    error = switch (failure) {
                      ExperienceFailure(code: 'invite_expired') => t(
                        '体验码已过期。',
                        'This code has expired.',
                      ),
                      ExperienceFailure(
                        code: 'invalid_invite' || 'invalid_request',
                      ) =>
                        t('请核对体验码。', 'Check the experience code.'),
                      ExperienceFailure(code: 'enrollment_inactive') => t(
                        '这个体验码已失效，请换一个。',
                        'This code is no longer active. Try another one.',
                      ),
                      ExperienceFailure(code: 'rate_limited') => t(
                        '操作太频繁，请稍后再试。',
                        'Too many attempts. Try again shortly.',
                      ),
                      _ => t(
                        '暂时无法兑换，请稍后重试。',
                        'Could not redeem. Try again shortly.',
                      ),
                    };
                  });
                }
              }

              return FutureBuilder<_CodeStatus>(
                future: status,
                builder: (context, snapshot) {
                  final pending =
                      snapshot.connectionState != ConnectionState.done;
                  final active =
                      !pending && snapshot.data == _CodeStatus.active;
                  final failed =
                      !pending && snapshot.data == _CodeStatus.unavailable;
                  final canRedeem = !pending && !active && !failed;
                  return PopScope(
                    canPop: !saving,
                    child: AlertDialog(
                      scrollable: true,
                      title: Text(t('体验码', 'Experience code')),
                      content: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            active
                                ? t(
                                    '这台设备的 Space 都可以使用体验服务。',
                                    'All Spaces on this device can use the experience service.',
                                  )
                                : failed
                                ? t(
                                    '暂时无法检查体验资格，请检查网络后重试。',
                                    'Could not check access. Check your connection and try again.',
                                  )
                                : t(
                                    '兑换一次，这台设备上的 Space 都可以使用体验服务。',
                                    'Redeem once to use the experience service in any Space on this device.',
                                  ),
                          ),
                          if (canRedeem)
                            TextField(
                              controller: code,
                              enabled: !saving,
                              obscureText: true,
                              autocorrect: false,
                              enableSuggestions: false,
                              maxLength: 128,
                              decoration: InputDecoration(
                                labelText: t('输入体验码', 'Enter experience code'),
                              ),
                              onSubmitted: (_) => redeem(),
                            ),
                          if (pending || saving)
                            const LinearProgressIndicator(),
                          if (error != null)
                            Text(
                              error!,
                              style: const TextStyle(color: Nova.red),
                            ),
                        ],
                      ),
                      actions: [
                        TextButton(
                          onPressed: saving
                              ? null
                              : () => Navigator.pop(context),
                          child: Text(
                            active ? t('完成', 'Done') : t('取消', 'Cancel'),
                          ),
                        ),
                        if (failed)
                          FilledButton(
                            onPressed: () {
                              final next = checkAccess();
                              update(() {
                                status = next;
                              });
                            },
                            child: Text(t('重试', 'Retry')),
                          ),
                        if (canRedeem)
                          FilledButton(
                            onPressed: saving ? null : redeem,
                            child: Text(t('兑换', 'Redeem code')),
                          ),
                      ],
                    ),
                  );
                },
              );
            },
          ),
        ) ??
        false;
  } finally {
    code.dispose();
  }
}
