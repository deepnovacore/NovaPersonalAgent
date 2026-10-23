import 'package:flutter/material.dart';

class SpaceChatMessage extends StatelessWidget {
  const SpaceChatMessage({super.key, required this.message});
  final Map<String, dynamic> message;
  @override
  Widget build(BuildContext context) {
    final user = message['role'] == 'user';
    final status = message['status'];
    final explanation = switch (status) {
      'interrupted' => 'Host 重启或执行中断，回复未完成。不会自动重发。',
      'cancelled' => '回复已取消。',
      'failed' =>
        user
            ? switch (message['error']) {
                'conversation_busy' => 'Host 正在处理上一条消息，本条未被接受。',
                'chat_expired' => '消息已过期，Host 未执行。',
                _ => 'Host 未接受此消息。',
              }
            : 'Host 未能完成回复。',
      'unknown' => '发送结果未确认，恢复连接后将补拉回复。不会自动重发。',
      'sending' => '正在发送…',
      _ => '',
    };
    final text = message['text'] as String? ?? '';
    return Card(
      child: ListTile(
        title: Text(user ? '我' : 'Host'),
        subtitle: Text(
          [
            if (text.isNotEmpty) text,
            if (explanation.isNotEmpty) explanation,
          ].join('\n'),
        ),
      ),
    );
  }
}
