import 'package:flutter/material.dart';
import '../ui/theme.dart';

String spaceChatStatusText(
  Map<String, dynamic> message, {
  String language = 'zh',
}) {
  String t(String zh, String en) => language == 'zh' ? zh : en;
  final user = message['role'] == 'user';
  final reason = message['failure_reason'] ?? message['error'];
  switch (message['status']) {
    case 'failed':
      if (user && message['failure_reason'] == null) {
        return switch (reason) {
          'conversation_busy' => t(
            'Host 正在处理上一条消息，本条未被接受。请稍后手动重试。',
            'The host is still handling the previous message, so this one was not accepted. Retry manually later.',
          ),
          'chat_expired' => t(
            '消息已过期，Host 未执行。请手动重试。',
            'The message expired before the host ran it. Retry manually.',
          ),
          _ => t(
            'Host 未接受此消息。请检查连接后手动重试。',
            'The host did not accept this message. Check the connection and retry manually.',
          ),
        };
      }
      final detail = switch (reason) {
        'authentication' => t(
          '模型服务认证失败，请检查 Host 的密钥设置。',
          'The model service rejected its credentials. Check the host’s key settings.',
        ),
        'quota' => t(
          '模型服务额度不足，请检查 Host 的账户额度。',
          'The model service quota is exhausted. Check the host’s account quota.',
        ),
        'rate_limited' => t(
          '模型服务请求过于频繁，请稍后再试。',
          'The model service is rate limiting requests. Try again later.',
        ),
        'network' => t(
          'Host 无法连接模型服务，请检查 Host 的网络。',
          'The host cannot reach the model service. Check the host’s network.',
        ),
        'timeout' => t(
          '模型回复超时，请稍后再试。',
          'The model reply timed out. Try again later.',
        ),
        'output_limit' => t(
          '模型回复达到输出限制，请缩短问题后再试。',
          'The reply hit the output limit. Shorten the question and try again.',
        ),
        'configuration' => t(
          'Host 尚未配置可用的模型服务，请检查模型设置。',
          'The host has no usable model service configured. Check model settings.',
        ),
        _ => t(
          '模型未能完成回复，请检查 Host 的模型设置。',
          'The model could not finish the reply. Check the host’s model settings.',
        ),
      };
      return '$detail ${t('不会自动重发，请手动重试。', 'Nothing is resent automatically; retry manually.')}';
    case 'interrupted':
      return t(
        'Host 重启或执行中断，回复未完成。不会自动重发，请手动重试。',
        'The host restarted or the run was interrupted before the reply finished. Nothing is resent automatically; retry manually.',
      );
    case 'cancelled':
      return t('回复已取消。', 'Reply cancelled.');
    case 'unknown':
      return t(
        '发送结果未确认，恢复连接后将补拉回复。不会自动重发。',
        'Delivery is unconfirmed; the reply will be fetched once the connection returns. Nothing is resent automatically.',
      );
    case 'sending':
      return t('正在发送…', 'Sending…');
    default:
      return '';
  }
}

/// Same message look as the local chat: the user's words sit in a right-aligned
/// bubble, the assistant's reply is plain full-width text.
class SpaceChatMessage extends StatelessWidget {
  const SpaceChatMessage({
    super.key,
    required this.message,
    this.onRetry,
    this.language = 'zh',
  });
  final Map<String, dynamic> message;
  final String language;
  final VoidCallback? onRetry;
  @override
  Widget build(BuildContext context) {
    final user = message['role'] == 'user';
    final status = message['status'];
    final explanation = spaceChatStatusText(message, language: language);
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
                  TextButton(
                    onPressed: onRetry,
                    child: Text(language == 'zh' ? '手动重试' : 'Retry manually'),
                  ),
              ],
            ),
    );
  }
}
