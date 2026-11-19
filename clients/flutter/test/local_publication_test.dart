import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/local_publication.dart';

import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  test('fixed local publication scope persists and refuses work after scope closes', () async {
    final disk = MemoryLifePersistence();
    var active = true;
    final scope = LocalPublicationContext(
      disk,
      permitsPublication: () => active,
    );
    await scope.open();
    final space = scope.spaceId, device = scope.deviceId;
    scope.requireCurrent();
    final reopened = LocalPublicationContext(disk);
    await reopened.open();
    expect(reopened.spaceId, space);
    expect(reopened.deviceId, device);
    active = false;
    expect(scope.canPublish, false);
    expect(scope.requireCurrent, throwsStateError);
    reopened.dispose();
    expect(reopened.canPublish, false);
  });
}
