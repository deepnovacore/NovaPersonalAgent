import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../personal/local_life.dart';

/// Small, bounded context snapshots; device-only keychain on iOS and the
/// secure-storage plugin's Keystore-protected encrypted storage on Android.
class SecureContextPersistence implements LifePersistence {
  const SecureContextPersistence(this.key);
  final String key;
  static const storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.unlocked_this_device,
    ),
  );
  @override
  Future<String?> read() => storage.read(key: key);
  @override
  Future<void> write(String value) => storage.write(key: key, value: value);
}
