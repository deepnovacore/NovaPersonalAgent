import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'standalone_probe.dart';

// Opt-in acceptance entrypoint, like ios_hub_acceptance.dart. Not the normal UI.
void main() => runApp(const MaterialApp(home: StandaloneAcceptance()));

class StandaloneAcceptance extends StatefulWidget {
  const StandaloneAcceptance({super.key});
  @override
  State<StandaloneAcceptance> createState() => _StandaloneAcceptanceState();
}

class _StandaloneAcceptanceState extends State<StandaloneAcceptance> {
  String status = 'Synthetic persistence probe running';
  @override
  void initState() {
    super.initState();
    unawaited(run());
  }

  Future<void> run() async {
    final result = <String, dynamic>{
      'fixture': 'standalone_synthetic_storage',
      'passed': false,
      'scope': 'No model, native actions, Hub, normal UI or process restart',
    };
    try {
      final docs = await getApplicationDocumentsDirectory();
      final directory = await Directory(
        '${docs.path}/standalone-probe-',
      ).createTemp();
      result['run_directory'] = directory.uri.pathSegments
          .where((s) => s.isNotEmpty)
          .last;
      result['checks'] = await runStandaloneProbe(directory);
      result['passed'] = true;
      result['finished_at'] = DateTime.now().toUtc().toIso8601String();
      await File('${directory.path}/result.json').writeAsString(
        const JsonEncoder.withIndent('  ').convert(result),
        flush: true,
      );
      if (mounted) setState(() => status = jsonEncode(result));
    } catch (_) {
      // Never serialize arbitrary platform errors, paths or service responses.
      if (mounted) {
        setState(
          () => status = 'FAILED: standalone_probe_failed; no acceptance',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Nova synthetic standalone acceptance')),
    body: SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: SelectableText(status),
      ),
    ),
  );
}
