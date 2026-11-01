import '../agent/phone_channel.dart';
import '../agent/phone_run.dart';
import 'tool_step.dart';

/// A phone step event as a chat timeline row: `tool` -> name, `label` ->
/// narration, `ref` -> refLabel, `step` -> stepIndex.
ToolStep phoneStepToToolStep(PhoneStepEvent event, String language) => ToolStep(
  name: event.tool,
  status: switch (event.status) {
    StepStatus.running => 'running',
    StepStatus.completed => 'completed',
    StepStatus.failed => 'failed',
    StepStatus.unknown => 'outcome_unknown',
  },
  language: language,
  narration: event.label.trim().isEmpty ? null : event.label,
  refLabel: event.ref,
  stepIndex: event.step,
);

/// The run's steps in the vocabulary of the chat timeline.
List<ToolStep> phoneRunToolSteps(PhoneRun run, String language) => [
  for (final event in run.stepEvents) phoneStepToToolStep(event, language),
];
