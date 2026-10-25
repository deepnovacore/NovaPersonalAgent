import 'package:flutter/material.dart';
import '../ui/theme.dart';

/// Same message look as the local chat: the user's words sit in a right-aligned
/// bubble, the assistant's reply is plain full-width text.
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
    final warn = status == 'failed' || status == 'unknown';
    final note = explanation.isEmpty
        ? null
        : Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              explanation,
              textAlign: user ? TextAlign.end : TextAlign.start,
              style: TextStyle(
                color: warn ? Nova.amber : Nova.secondary,
                fontSize: 13,
                height: 1.4,
              ),
            ),
          );
    return Padding(
      padding: const EdgeInsets.only(bottom: 22),
      child: user
          ? Align(
              alignment: Alignment.centerRight,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 300),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    if (text.isNotEmpty)
                      DecoratedBox(
                        decoration: BoxDecoration(
                          color: Nova.cell,
                          borderRadius: BorderRadius.circular(22),
                        ),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 17,
                            vertical: 13,
                          ),
                          child: SelectableText(
                            text,
                            style: const TextStyle(
                              color: Nova.text,
                              fontSize: 16,
                              height: 1.5,
                            ),
                          ),
                        ),
                      ),
                    ?note,
                  ],
                ),
              ),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (text.isNotEmpty)
                  SelectableText(
                    text,
                    style: const TextStyle(
                      color: Nova.text,
                      fontSize: 16,
                      height: 1.6,
                    ),
                  ),
                ?note,
              ],
            ),
    );
  }
}
