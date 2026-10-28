import 'package:flutter/material.dart';

/// An operator-issued invitation is entered only at first enrollment. The
/// installation credential is persisted separately by SpacePushClient.
class PushInvitationDialog extends StatefulWidget {
  const PushInvitationDialog({super.key});
  @override
  State<PushInvitationDialog> createState() => _PushInvitationDialogState();
}

class _PushInvitationDialogState extends State<PushInvitationDialog> {
  final input = TextEditingController();
  @override
  void dispose() {
    input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('兑换通知邀请'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text('请输入通知服务提供的一次性邀请。兑换后此安装中的 Space 共用通知准入，不会开启其他 Space 的通知。'),
        TextField(
          controller: input,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          maxLength: 4096,
          decoration: const InputDecoration(
            labelText: '一次性邀请',
            counterText: '',
          ),
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(
        onPressed: () => Navigator.pop(context, input.text.trim()),
        child: const Text('兑换'),
      ),
    ],
  );
}
