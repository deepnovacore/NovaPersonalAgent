import 'space/space_storage.dart';
import 'space/native_scope.dart';
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
  final space = await SpaceStorage.readActive();
  if (space?.mode != SpaceMode.standalone) return;
  await SpaceNativeScope.activate(space);
  await SpaceStorage.runScoped(space, () async {
    await ScheduledAgentRunner.open(
      LifeHost(backgroundReader: true),
      ModelSettings(headless: true),
      headless: true,
    );
  });
}
