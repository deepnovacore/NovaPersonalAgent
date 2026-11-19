import 'package:flutter/material.dart';
import '../ui/theme.dart';

String spaceChatStatusText(Map<String, dynamic> message) {
  final user = message['role'] == 'user';
  final reason = message['failure_reason'] ?? message['error'];
  switch (message['status']) {
    case 'failed':
      if (user && message['failure_reason'] == null) {
        return switch (reason) {
          'conversation_busy' => 'Host 正在处理上一条消息，本条未被接受。请稍后手动重试。',
          'chat_expired' => '消息已过期，Host 未执行。请手动重试。',
          _ => 'Host 未接受此消息。请检查连接后手动重试。',
        };
      }
      final detail = switch (reason) {
        'authentication' => '模型服务认证失败，请检查 Host 的密钥设置。',
        'quota' => '模型服务额度不足，请检查 Host 的账户额度。',
        'rate_limited' => '模型服务请求过于频繁，请稍后再试。',
        'network' => 'Host 无法连接模型服务，请检查 Host 的网络。',
        'timeout' => '模型回复超时，请稍后再试。',
        'output_limit' => '模型回复达到输出限制，请缩短问题后再试。',
        'configuration' => 'Host 尚未配置可用的模型服务，请检查模型设置。',
        _ => '模型未能完成回复，请检查 Host 的模型设置。',
      };
      return '$detail 不会自动重发，请手动重试。';
    case 'interrupted':
      return 'Host 重启或执行中断，回复未完成。不会自动重发，请手动重试。';
    case 'cancelled':
      return '回复已取消。';
    case 'unknown':
      return '发送结果未确认，恢复连接后将补拉回复。不会自动重发。';
    case 'sending':
      return '正在发送…';
    default:
      return '';
  }
}

/// Same message look as the local chat: the user's words sit in a right-aligned
/// bubble, the assistant's reply is plain full-width text.
class SpaceChatMessage extends StatelessWidget {
  const SpaceChatMessage({super.key, required this.message, this.onRetry});
  final Map<String, dynamic> message;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) {
    final user = message['role'] == 'user';
    final status = message['status'];
    final explanation = spaceChatStatusText(message);
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
                if (onRetry != null &&
                    (status == 'failed' || status == 'interrupted'))
                  TextButton(onPressed: onRetry, child: const Text('手动重试')),
              ],
            ),
    );
  }
}
