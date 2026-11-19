import 'dart:convert';
import 'package:flutter/services.dart';
import 'client_state.dart';

abstract interface class SpaceMobileTools {
  Future<bool> requestPermission(String tool);
  Future<Map<String, dynamic>> execute(
    String id,
    String tool,
    Map<String, dynamic> args,
  );
}

class NativeSpaceMobileTools implements SpaceMobileTools {
  static const channel = MethodChannel('nova/space_tools');
  @override
  Future<bool> requestPermission(String tool) async =>
      await channel.invokeMethod<bool>('requestPermission', {'tool': tool}) ??
      false;
  @override
  Future<Map<String, dynamic>> execute(
    String id,
    String tool,
    Map<String, dynamic> args,
  ) async => Map<String, dynamic>.from(
    await channel.invokeMapMethod<String, dynamic>('execute', {
          'action_id': id,
          'tool': tool,
          'args': args,
        }) ??
        {},
  );
}

class SpaceMobileActions {
  SpaceMobileActions(this.state, this.tools, {required this.isForeground});
  final SpaceClientState state;
  final SpaceMobileTools tools;
  final bool Function() isForeground;
  Future<Map<String, dynamic>> handle(Map<String, dynamic> action) =>
      state.transaction(() async {
        final id = action['action_id'] as String;
        final fingerprint = jsonEncode({
          'tool': action['tool'],
          'args': action['args'],
          'expires_at': action['expires_at'],
        });
        final previous = state.effects[id];
        if (previous != null) {
          if (previous['fingerprint'] != fingerprint) {
            return {
              'action_id': id,
              'status': 'denied',
              'error': 'action_id_conflict',
            };
          }
          return {
            for (final k in ['action_id', 'status', 'result', 'error'])
              if (previous.containsKey(k)) k: previous[k],
          };
        }
        final result = <String, dynamic>{
          'action_id': id,
          'fingerprint': fingerprint,
          'status': 'executing',
        };
        state.effects[id] = result;
        await state
            .save(); // Admission precedes permission requests and all effects.
        var effectStarted = false;
        try {
          final tool = action['tool'] as String;
          final args = Map<String, dynamic>.from(action['args'] as Map);
          final allowed = const {
            'calendar.read',
            'reminder.create',
            'camera.capture',
          }.contains(tool);
          if (!allowed ||
              !isForeground() ||
              (action['expires_at'] as int) <=
                  DateTime.now().millisecondsSinceEpoch) {
            result.addAll({
              'status': 'denied',
              'error': !allowed
                  ? 'unsupported_tool'
                  : !isForeground()
                  ? 'foreground_required'
                  : 'action_expired',
            });
          } else if (!await tools.requestPermission(tool)) {
            result.addAll({'status': 'denied', 'error': 'permission_denied'});
          } else {
            // Permission dialogs may outlive the request deadline.
            if (!isForeground() ||
                (action['expires_at'] as int) <=
                    DateTime.now().millisecondsSinceEpoch) {
              result.addAll({'status': 'denied', 'error': 'action_expired'});
            } else {
              effectStarted = true;
              final output = await tools.execute(id, tool, args);
              result.addAll({'status': 'completed', 'result': output});
            }
          }
        } on MissingPluginException {
          result.addAll({'status': 'denied', 'error': 'unsupported_platform'});
        } on PlatformException catch (error) {
          final denied = [
            'permission_denied',
            'unsupported',
            'unsupported_platform',
          ].contains(error.code);
          result.addAll({
            'status': denied
                ? 'denied'
                : effectStarted
                ? 'unknown'
                : 'failed',
            'error': error.code,
          });
        } catch (_) {
          result.addAll({
            'status': effectStarted ? 'unknown' : 'failed',
            'error': 'device_action_failed',
          });
        }
        await state.save();
        state.changed();
        return {
          for (final k in ['action_id', 'status', 'result', 'error'])
            if (result.containsKey(k)) k: result[k],
        };
      });
}
