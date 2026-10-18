import 'package:flutter/material.dart';
import 'ui/app.dart';
import 'agent_core/scheduled_agent_runner.dart';
import 'agent_core/model_settings.dart';
import 'personal/life_host.dart';
export 'ui/app.dart' show NovaApp;

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const NovaApp());
}

@pragma('vm:entry-point')
Future<void> novaScheduleMain() async {
  WidgetsFlutterBinding.ensureInitialized();
  await ScheduledAgentRunner.open(
    LifeHost(backgroundReader: true),
    ModelSettings(headless: true),
    headless: true,
  );
}
