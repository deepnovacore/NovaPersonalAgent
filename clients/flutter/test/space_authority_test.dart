import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/device/space_authority.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test(
    'PC authority survives restart and disconnection without phone promotion',
    () async {
      final persistence = MemoryLifePersistence();
      var repository = SpaceAuthorityRepository(persistence);
      await repository.open();
      expect(repository.canPublish, true);
      final localDevice = repository.deviceId;
      final remote = {
        'protocol_version': 1,
        'space_id': 'account',
        'authority_epoch': 2,
        'membership_revision': 2,
        'primary_device_id': 'pc',
        'mode': 'pc_primary',
        'pending': null,
      };
      await repository.bind(hubId: 'hub', deviceId: 'phone', record: remote);
      expect(repository.canPublish, false);
      repository = SpaceAuthorityRepository(persistence);
      await repository.open();
      expect(repository.primaryDeviceId, 'pc');
      expect(repository.deviceId, 'phone');
      expect(repository.canPublish, false);
      expect(repository.localDeviceId, localDevice);
      expect(() => repository.validatePublish(2), throwsStateError);
      await expectLater(
        repository.accept({...remote, 'authority_epoch': 1}),
        throwsStateError,
      );
      await expectLater(
        repository.accept({...remote, 'primary_device_id': 'phone'}),
        throwsStateError,
      );
      expect(repository.primaryDeviceId, 'pc');
    },
  );
  test('pending transition freezes publication', () async {
    final persistence = MemoryLifePersistence();
    final repository = SpaceAuthorityRepository(persistence);
    await repository.open();
    final record = repository.record;
    await repository.accept({
      ...record,
      'membership_revision': 2,
      'pending': {
        'transition_id': 'bind',
        'from_device_id': repository.deviceId,
        'target_device_id': 'pc',
        'expected_epoch': 1,
        'acknowledged': [repository.deviceId],
      },
    });
    expect(repository.canPublish, false);
    expect(() => repository.validatePublish(1), throwsStateError);
    await expectLater(repository.accept(record), throwsStateError);
    await expectLater(
      repository.accept({...record, 'membership_revision': 2}),
      throwsStateError,
    );
    expect(repository.canPublish, false);
  });
}
