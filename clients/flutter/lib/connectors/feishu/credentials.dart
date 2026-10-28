import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../../personal/local_life.dart';
import '../../space/space_storage.dart';

/// Application and OAuth credentials never share the Nova SSO/device-token key.
class FeishuCredentialPersistence implements LifePersistence {
  FeishuCredentialPersistence({FlutterSecureStorage? storage})
    : storage =
          storage ??
          const FlutterSecureStorage(
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.unlocked_this_device,
            ),
          );
  final FlutterSecureStorage storage;
  final _key = SpaceStorage.secureKey('nova.feishu.direct.v1');
  @override
  Future<String?> read() => storage.read(key: _key);
  @override
  Future<void> write(String value) =>
      storage.write(key: _key, value: value);
}
