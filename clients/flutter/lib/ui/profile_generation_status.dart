import 'package:flutter/material.dart';
import '../context/profile_generation_coordinator.dart';
import 'theme.dart';

class ProfileGenerationStatus extends StatelessWidget {
  const ProfileGenerationStatus({
    super.key,
    required this.generation,
    this.language = 'zh',
    this.empty = false,
    this.compact = false,
    this.emptyLabel,
    this.waitingHint,
    this.onOpenConnectors,
  });
  final ProfileGenerationCoordinator generation;
  final String language;
  final bool empty, compact;
  final String? emptyLabel;

  /// Replaces the default waiting copy with the reason that applies now.
  final String? waitingHint;
  final VoidCallback? onOpenConnectors;
  String t(String zh, String en) => language == 'zh' ? zh : en;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: generation,
    builder: (context, _) {
      final phase = generation.phase, code = generation.code;
      if (phase == ProfileGenerationPhase.ready && !empty) {
        return const SizedBox.shrink();
      }
      final title = switch (phase) {
        ProfileGenerationPhase.working => t('正在整理你的近况…', 'Updating…'),
        ProfileGenerationPhase.continuing => t(
          '已整理一部分，接着补充',
          'Adding updates…',
        ),
        ProfileGenerationPhase.paused => t('已暂停整理', 'Paused'),
        ProfileGenerationPhase.failed => t('这次没整理完，稍后会再试', 'Retrying shortly'),
        ProfileGenerationPhase.blocked =>
          code == 'profile_timeline_partial'
              ? t('已保存部分近况', 'Some updates saved')
              : code == 'profile_timeline_invalid'
              ? t('这次近况未通过校验', 'Updates failed validation')
              : t('暂时无法继续整理', 'Updates paused'),
        ProfileGenerationPhase.ready =>
          emptyLabel ?? t('暂时没有可确认的内容', 'No confirmed updates yet'),
        _ => waitingHint ?? t('消息同步后，会自动整理到这里', 'Waiting for sync'),
      };
      final detail = code == 'profile_timeline_partial'
          ? t(
              '部分内容未通过核对，已保留合格内容并停止自动重试。',
              'Some content failed checks. Valid updates were kept; automatic retries stopped.',
            )
          : code == 'profile_timeline_invalid'
          ? t(
              '生成内容的格式或原文引用不符合要求，已停止自动重试。已有内容会保留。',
              'Generated content failed format or source checks. Automatic retries stopped. Existing results kept.',
            )
          : {
              'processing_not_allowed',
              'processing_consent_required',
            }.contains(code)
          ? t('允许模型使用消息后，就会自动开始。', 'Allow this model to use messages to start.')
          : code == 'model_required'
          ? t('先在设置中选好模型。', 'Choose a model in Settings.')
          : phase == ProfileGenerationPhase.working ||
                phase == ProfileGenerationPhase.continuing
          ? empty
                ? t('整理好后会自动显示在这里。', 'Results will appear here.')
                : t('可以先查看已有内容，新内容会陆续补上。', 'Adding more results.')
          : phase == ProfileGenerationPhase.paused ||
                phase == ProfileGenerationPhase.failed ||
                phase == ProfileGenerationPhase.blocked
          ? t('已整理的内容会保留。', 'Existing results kept.')
          : null;
      return Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (compact &&
                (phase == ProfileGenerationPhase.working ||
                    phase == ProfileGenerationPhase.continuing))
              Semantics(
                liveRegion: true,
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 3, right: 10),
                      child: ExcludeSemantics(
                        child: SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(
                            key: const ValueKey('feishu.generation.spinner'),
                            strokeWidth: 2,
                          ),
                        ),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        title,
                        style: const TextStyle(
                          color: Nova.secondary,
                          height: 1.5,
                        ),
                      ),
                    ),
                  ],
                ),
              )
            else ...[
              if (!compact && phase == ProfileGenerationPhase.working) ...[
                const LinearProgressIndicator(minHeight: 2),
                const SizedBox(height: 10),
              ],
              Semantics(
                liveRegion: true,
                child: Text(
                  title,
                  style: const TextStyle(color: Nova.secondary, height: 1.5),
                ),
              ),
            ],
            if (detail != null)
              Text(
                detail,
                style: const TextStyle(
                  color: Nova.tertiary,
                  fontSize: 12,
                  height: 1.5,
                ),
              ),
            Wrap(
              spacing: 8,
              children: [
                if (phase == ProfileGenerationPhase.working ||
                    phase == ProfileGenerationPhase.continuing ||
                    phase == ProfileGenerationPhase.failed)
                  TextButton(
                    onPressed: generation.pause,
                    child: Text(t('暂停', 'Pause')),
                  ),
                if (phase == ProfileGenerationPhase.paused ||
                    phase == ProfileGenerationPhase.failed ||
                    phase == ProfileGenerationPhase.blocked &&
                        code != 'profile_budget_unavailable')
                  TextButton(
                    onPressed: generation.retry,
                    child: Text(
                      t(
                        phase == ProfileGenerationPhase.paused ? '继续' : '重试',
                        phase == ProfileGenerationPhase.paused
                            ? 'Continue'
                            : 'Retry',
                      ),
                    ),
                  ),
                if (phase == ProfileGenerationPhase.waiting &&
                    onOpenConnectors != null)
                  TextButton(
                    onPressed: onOpenConnectors,
                    child: Text(t('打开连接器', 'Open connectors')),
                  ),
              ],
            ),
          ],
        ),
      );
    },
  );
}
