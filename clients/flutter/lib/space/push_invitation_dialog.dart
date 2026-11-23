import 'package:flutter/material.dart';

/// An operator-issued invitation is entered only at first enrollment. The
/// installation credential is persisted separately by SpacePushClient.
class PushInvitationDialog extends StatefulWidget {
  const PushInvitationDialog({super.key, this.language = 'zh'});
  final String language;
  @override
  State<PushInvitationDialog> createState() => _PushInvitationDialogState();
}

class _PushInvitationDialogState extends State<PushInvitationDialog> {
  final input = TextEditingController();
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(t('兑换通知邀请', 'Redeem notification invitation')),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          t(
            '请输入通知服务提供的一次性邀请。兑换后此安装中的 Space 共用通知准入，不会开启其他 Space 的通知。',
            'Enter the one-time invitation from the notification service. Spaces in this installation then share notification access; it does not turn on notifications for other Spaces.',
          ),
        ),
        TextField(
          controller: input,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          maxLength: 4096,
          decoration: InputDecoration(
            labelText: t('一次性邀请', 'One-time invitation'),
            counterText: '',
          ),
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: Text(t('取消', 'Cancel')),
      ),
      FilledButton(
        onPressed: () => Navigator.pop(context, input.text.trim()),
        child: Text(t('兑换', 'Redeem')),
      ),
    ],
  );
}
