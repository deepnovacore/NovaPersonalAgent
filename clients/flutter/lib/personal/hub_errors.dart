import 'dart:async';
import 'dart:io';

class HubPairingException implements Exception {
  const HubPairingException(this.code);
  final String code;
  @override
  String toString() => 'HubPairingException';
}

/// Only local, allowlisted codes reach the UI; never display server text.
String hubErrorMessage(Object error, {String language = 'zh'}) {
  final code = switch (error) {
    HubPairingException e => e.code,
    FormatException e => e.message,
    StateError e => e.message,
    SocketException() ||
    TimeoutException() ||
    HandshakeException() => 'network',
    _ => 'unknown',
  };
  final messages = switch (code) {
    'device_name_required' => ('请输入这台手机的名称。', 'Enter a name for this phone.'),
    'Hub requires HTTPS' => (
      'Hub 地址必须使用 HTTPS。',
      'The Hub address must use HTTPS.',
    ),
    'Invalid Hub address' => ('Hub 地址格式不正确。', 'The Hub address is invalid.'),
    'device_token_required' => ('请输入设备令牌。', 'Enter a device token.'),
    'tailscale_required' => (
      '请扫描 Mac 通过 Tailscale 生成的 Hub 二维码。',
      'Scan a Hub QR code generated through Tailscale on your Mac.',
    ),
    'invalid_qr' => (
      '这不是有效的 Hub 配对二维码。',
      'This is not a valid Hub pairing QR code.',
    ),
    'unsupported_qr' => (
      '二维码类型或版本不支持，请在 Mac 的手机同步 Hub 页面重新生成。',
      'Unsupported QR type or version. Generate a new code in Mobile sync Hub on your Mac.',
    ),
    'invalid_pairing' || 'expired' => (
      '二维码已失效、已使用或已取消，请在 Mac 上重新生成。',
      'The QR code expired, was used or was cancelled. Generate a new one on your Mac.',
    ),
    'account_mismatch' => (
      '本机资料已绑定其他账号，不能直接切换。原有资料和连接已保留。',
      'Local data belongs to another account. Your data and connection have been kept.',
    ),
    'hub_identity_changed' || 'pairing_identity_mismatch' => (
      'Hub 身份与当前资料不匹配，原有连接已保留。',
      'The Hub identity does not match your data. Your existing connection has been kept.',
    ),
    'hub_history_reset' => (
      'Hub 同步历史发生变化，请检查服务器数据。',
      'The Hub sync history changed. Check the server data.',
    ),
    'device_capacity' => (
      'Hub 已达到设备上限，请在 Mac 上撤销不用的设备。',
      'The Hub device limit was reached. Revoke an unused device on your Mac.',
    ),
    'rate_limited' => (
      '配对请求过于频繁，请一分钟后重试。',
      'Too many pairing requests. Try again in a minute.',
    ),
    'network' => (
      '无法连接 Hub。请确认 Mac 在线、两端 Tailscale 已连接，并检查 Android 是否正在使用其他 VPN。',
      'Cannot reach the Hub. Check your Mac is online, Tailscale is connected on both devices, and another Android VPN is not interfering.',
    ),
    'save_failed' => (
      '无法安全保存连接。请检查设备安全存储后重试；如二维码已使用，请在 Mac 上重新生成。',
      'Could not save the connection securely. Check secure storage and try again. If the code was used, generate a new one on your Mac.',
    ),
    'invalid_response' => (
      'Hub 返回了无效的配对结果，连接未保存。请重新生成二维码。',
      'The Hub returned an invalid pairing result. Nothing was saved. Generate a new QR code.',
    ),
    _ => (
      'Hub 操作失败，请检查连接、账号和同步状态。',
      'Hub operation failed. Check the connection, account and sync status.',
    ),
  };
  return language == 'zh' ? messages.$1 : messages.$2;
}
