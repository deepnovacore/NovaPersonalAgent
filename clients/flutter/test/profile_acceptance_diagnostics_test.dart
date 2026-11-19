import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_acceptance_diagnostics.dart';
import 'package:nova_mobile/context/profile_agent.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'unknown provider error codes retain their HTTP status without provider text',
    () {
      expect(
        profileRunErrorCode(
          const ModelRequestFailure(
            'private-server-code',
            status: 400,
            body: 'private-response',
          ),
        ),
        'model_http_400',
      );
    },
  );
  test(
    'diagnostics keep distinct bounded failures and exclude source or response content',
    () async {
      final disk = MemoryLifePersistence();
      var receipt = <String, dynamic>{
        'status': 'interrupted',
        'last_stage': 'edit',
        'error_code': 'profile_timeline_invalid',
        'coverage': {'eligible_records': 42, 'source_body': 'private-source'},
        'pipeline_validation': {
          'first': {
            'stage': 'timeline_compose',
            'reason': 'fact_quote_not_exact',
            'path': 'timeline[0].brief.facts[0].quote',
            'invalid_index': 2,
            'quote': 'private-quote',
            'response': 'private-response',
          },
          'last': {
            'stage': 'timeline_compose',
            'reason': 'private-reason',
            'path': 'private-path',
          },
        },
        'credential': 'private-key',
        'model_response': 'private-response',
        'transcript': 'private-transcript',
      };
      var state = <String, dynamic>{
        'phase': 'blocked',
        'code': 'profile_timeline_invalid',
        'budget_cap_microyuan': 10000000,
        'budget_reserved_microyuan': 9926000,
        'source_body': 'private-source',
      };
      final diagnostics = ProfileAcceptanceDiagnostics(
        output: disk,
        readReceipt: () async => receipt,
        readState: () => state,
      );
      await diagnostics.capture(startup: true);
      await diagnostics.capture();
      var snapshots = (jsonDecode(disk.value!) as Map)['snapshots'] as List;
      expect(snapshots, hasLength(1));
      expect(snapshots.single['receipt']['last_stage'], 'edit');
      expect(
        snapshots.single['receipt']['pipeline_validation']['first']['reason'],
        'fact_quote_not_exact',
      );
      expect(
        snapshots.single['receipt']['pipeline_validation']['last'],
        isNull,
      );
      receipt = {'status': 'paused', 'error_code': 'profile_budget_exhausted'};
      state = {...state, 'code': 'profile_budget_exhausted'};
      await diagnostics.capture();
      snapshots = (jsonDecode(disk.value!) as Map)['snapshots'] as List;
      expect(snapshots, hasLength(2));
      expect(
        snapshots.first['receipt']['error_code'],
        'profile_timeline_invalid',
      );
      expect(snapshots.last['budget_cap_microyuan'], isNull);
      expect(snapshots.last['budget_reserved_microyuan'], 9926000);
      // Legacy hard-cap receipts stay diagnosable without any cap metadata.
      expect(
        snapshots.last['receipt']['error_code'],
        'profile_budget_exhausted',
      );
      for (var i = 0; i < 12; i++) {
        receipt = {
          'status': 'interrupted',
          'error_code': 'profile_timeline_invalid',
          'coverage': {'eligible_records': i},
        };
        await diagnostics.capture();
      }
      snapshots = (jsonDecode(disk.value!) as Map)['snapshots'] as List;
      expect(snapshots, hasLength(10));
      expect(snapshots.last['receipt']['coverage']['eligible_records'], 11);
      final saved = disk.value;
      state = {...state, 'phase': 'working'};
      await diagnostics.capture();
      expect(disk.value, saved);
      expect(disk.value, isNot(contains('private-')));
      expect(utf8.encode(disk.value!).length, lessThan(65536));
    },
  );
}
