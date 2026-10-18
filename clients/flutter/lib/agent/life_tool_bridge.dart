import 'package:flutter/services.dart';
import '../personal/local_life.dart';
import '../personal/life_reducer.dart';

/// Native host owns task authority; LocalLife remains the sole Life writer.
class LifeToolBridge {
  LifeToolBridge(this.repository);
  final LocalLife repository;
  static const channel = MethodChannel('nova/local_life/v1');
  void attach() => channel.setMethodCallHandler((call) async {
    try {
      return await handle(
        call.method,
        Map<String, dynamic>.from(call.arguments as Map? ?? {}),
      );
    } on StateError catch (error) {
      throw PlatformException(
        code: 'life_conflict_or_invalid',
        message: error.message.toString(),
      );
    }
  });
  void detach() => channel.setMethodCallHandler(null);
  Future<Map<String, dynamic>> handle(
    String method,
    Map<String, dynamic> args,
  ) async {
    if (!repository.ready) throw StateError('life_not_ready');
    if (method == 'snapshot') {
      final life = repository.life;
      return {
        'todos': (life['todos'] as List).take(100).toList(),
        'goals': life['goals'],
        'todo_limit': 100,
        'conflict': repository.conflict != null,
      };
    }
    if (!['validate', 'mutate'].contains(method)) {
      throw StateError('unsupported_life_tool');
    }
    final input = Map<String, dynamic>.from(args['input'] as Map);
    if (!['todo', 'goal'].contains(input['kind']) ||
        !['create', 'update'].contains(input['op'])) {
      throw StateError('unsupported_life_tool');
    }
    if (repository.conflict != null) throw StateError('resolve_conflict_first');
    if (method == 'validate') {
      reduceLife(repository.life, input, 'validation');
      return {'valid': true};
    }
    final operation = args['operation_id'];
    if (operation is! String || operation.isEmpty || operation.length > 100) {
      throw StateError('operation_id_required');
    }
    return repository.mutate(input, operationId: operation);
  }
}
