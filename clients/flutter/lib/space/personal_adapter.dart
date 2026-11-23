import 'dart:async';
import '../personal/personal_store.dart';
import 'client_state.dart';
import 'space_language.dart';
import 'space_storage.dart';

/// Shared personal pages, backed only by the encrypted Host outbox and cache.
class RemotePersonalAdapter {
  RemotePersonalAdapter(this.state, {required this.onSync}) {
    store = PersonalStore(
      send: (frame) {
        unawaited(_command(frame));
        return true;
      },
    );
    store.setConnected(true);
    state.addListener(_project);
    _project();
  }
  final SpaceClientState state;
  final Future<void> Function() onSync;
  late final PersonalStore store;
  int _revision = 0;
  bool _disposed = false;

  void _project() {
    if (_disposed) return;
    final snapshot = state.snapshot;
    final life = {
      for (final key in ['goals', 'todos', 'ideas', 'profile'])
        key: snapshot[key] ?? (key == 'profile' ? <String, dynamic>{} : []),
    };
    // Pending goal IDs remain selectable; dependent edits retain the Host remap.
    life['goals'] = [
      ...state.cards('goals'),
      for (final item in state.pending)
        if (item['kind'] == 'life.mutate' &&
            item['status'] == 'pending' &&
            (item['input'] as Map)['op'] == 'create' &&
            (item['input'] as Map)['kind'] == 'goal' &&
            item['temp_id'] != null)
          {
            ...(item['input'] as Map),
            'id': item['temp_id'],
            'version': 1,
            'status': 'active',
          },
    ];
    store.receive({
      'type': 'personal.state',
      'revision': ++_revision,
      'life': life,
      'profile_preparation': {'draft': snapshot['profile_presentation'] ?? {}},
      'tasks': snapshot['tasks'] ?? [],
      'feed': snapshot['feed'] ?? [],
    });
  }

  Future<void> _command(Map<String, dynamic> frame) async {
    try {
      final method = frame['method'];
      final params = Map<String, dynamic>.from(frame['params'] as Map? ?? {});
      if (method == 'state') {
        _project();
        unawaited(onSync().catchError((Object _) {}));
      } else if (method == 'life.mutate') {
        final version = params.remove('expected_version') as int?;
        if (params['op'] != 'create' && version == null) {
          throw StateError(spaceText('请刷新内容后重试', 'Refresh and try again'));
        }
        final dependencies = [
          for (final item in state.pending)
            if (item['temp_id'] != null &&
                [
                  params['id'],
                  params['goal_id'],
                  params['idea_id'],
                ].contains(item['temp_id']))
              item['op_id'] as String,
        ];
        await state.enqueue(
          'life.mutate',
          params,
          baseVersion: version,
          tempId: params['op'] == 'create' ? 'temp_${newSpaceId()}' : null,
          dependsOn: dependencies,
        );
        unawaited(onSync().catchError((Object _) {}));
      } else {
        throw StateError(spaceText('请在电脑上完成这项操作', 'Do this on your computer'));
      }
      if (!_disposed) {
        store.receive({
          'type': 'personal.result',
          'request_id': frame['request_id'],
          'ok': true,
        });
      }
    } catch (_) {
      if (!_disposed) {
        store.receive({
          'type': 'personal.result',
          'request_id': frame['request_id'],
          'ok': false,
          'error': spaceText(
            '未能保存，请刷新后重试。',
            'Could not save. Refresh and try again.',
          ),
        });
      }
    }
  }

  void dispose() {
    _disposed = true;
    state.removeListener(_project);
    store.dispose();
  }
}
