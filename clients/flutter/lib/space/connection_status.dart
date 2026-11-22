import 'relay_transport.dart';
import 'space_crypto.dart';
import 'space_storage.dart';

enum SpaceConnectionStatus {
  checking,
  online,
  offline,
  unreachable,
  awaitingApproval,
}

typedef SpaceConnectionProbe =
    Future<SpaceConnectionStatus> Function(SpaceRecord);

/// Check presence without starting a Client, replaying its outbox or pairing.
Future<SpaceConnectionStatus> probeSpaceConnection(
  SpaceRecord space, {
  Future<String?> Function(String)? readSecret,
  SpaceRelayTransport Function(SpaceCrypto)? createTransport,
}) async {
  final read = readSecret ?? (name) => SpaceSecurePersistence(name).read();
  SpaceRelayTransport? transport;
  try {
    final identity = await read('nova.space.identity.${space.id}');
    if (identity == null) return SpaceConnectionStatus.unreachable;
    final crypto = SpaceCrypto(
      space,
      SpaceIdentity.fromJson(jsonMap(identity)),
      _ProbeSecrets(await read('nova.space.keys.${space.id}')),
    );
    await crypto.load();
    transport =
        createTransport?.call(crypto) ??
        SpaceRelayTransport(
          crypto,
          allowLoopback: const bool.fromEnvironment(
            'NOVA_ALLOW_LOOPBACK_RELAY',
          ),
        );
    await transport.login();
    return await transport.hostOnline()
        ? SpaceConnectionStatus.online
        : SpaceConnectionStatus.offline;
  } on RelayFailure catch (error) {
    if ([
      'unknown_device',
      'inactive_device',
      'device_inactive',
    ].contains(error.code)) {
      try {
        if (await read('nova.space.pair-request.${space.id}') != null) {
          return SpaceConnectionStatus.awaitingApproval;
        }
      } catch (_) {}
    }
    return SpaceConnectionStatus.unreachable;
  } catch (_) {
    return SpaceConnectionStatus.unreachable;
  } finally {
    await transport?.dispose();
  }
}

/// Defence in depth: a presence check must never alter saved keys.
class _ProbeSecrets implements SpacePersistence {
  _ProbeSecrets(this.value);
  final String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String value) async {}
}
