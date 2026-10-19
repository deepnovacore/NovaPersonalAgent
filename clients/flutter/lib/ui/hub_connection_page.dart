import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import '../personal/life_host.dart';
import '../personal/hub_pairing.dart';
import '../personal/hub_errors.dart';
import 'hub_pairing_scanner.dart';

class HubConnectionPage extends StatefulWidget {
  const HubConnectionPage({
    super.key,
    required this.host,
    this.language = 'zh',
    this.scanCode,
    this.client,
  });
  final LifeHost host;
  final String language;
  final Future<String?> Function(BuildContext)? scanCode;
  final HubPairingClient? client;
  @override
  State<HubConnectionPage> createState() => _HubConnectionPageState();
}

class _HubConnectionPageState extends State<HubConnectionPage> {
  final _url = TextEditingController(), _token = TextEditingController();
  final _deviceName = TextEditingController(text: 'Android Nova');
  bool _busy = false, _connected = false;
  String? _message;
  String _text(String zh, String en) => widget.language == 'zh' ? zh : en;
  @override
  void initState() {
    super.initState();
    widget.host.readHubUrl().then((url) {
      if (mounted) _url.text = url ?? '';
    });
  }

  @override
  void dispose() {
    _url.dispose();
    _token.dispose();
    _deviceName.dispose();
    super.dispose();
  }

  void _fail(Object error) {
    if (mounted) {
      setState(
        () => _message = hubErrorMessage(error, language: widget.language),
      );
    }
  }

  Future<void> _scan() async {
    if (_busy) return;
    if (_deviceName.text.trim().isEmpty) {
      _fail(const HubPairingException('device_name_required'));
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
      _connected = false;
    });
    try {
      final raw =
          await (widget.scanCode?.call(context) ??
              Navigator.push<String>(
                context,
                MaterialPageRoute(
                  builder: (_) => HubPairingScanner(language: widget.language),
                ),
              ));
      if (raw == null || !mounted) return;
      final invitation = HubPairingInvitation.parse(raw);
      invitation.checkIdentity(
        accountId: widget.host.repo?.accountId,
        hubId: widget.host.repo?.hubId,
      );
      final accepted = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(_text('连接这台 Mac？', 'Connect to this Mac?')),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SelectableText(invitation.url.toString()),
              const SizedBox(height: 16),
              Text(
                _text(
                  '确认这是你的 Mac。连接后将同步 Todo、Idea、Goal 及其关联；本机已有资料会保留。',
                  'Confirm this is your Mac. Tasks, ideas, goals and their links will sync. Existing local data will be kept.',
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(_text('取消', 'Cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(_text('确认并连接', 'Confirm and connect')),
            ),
          ],
        ),
      );
      if (accepted != true || !mounted) return;
      invitation.checkIdentity(
        accountId: widget.host.repo?.accountId,
        hubId: widget.host.repo?.hubId,
      );
      final credential = await (widget.client ?? HubPairingClient()).redeem(
        invitation,
        deviceName: _deviceName.text.trim(),
      );
      if (!mounted) return;
      await widget.host.configureHub(
        url: invitation.url.toString(),
        token: credential.token,
        expectedHubId: invitation.hubId,
        expectedAccountId: invitation.accountId,
      );
      await _finish();
    } catch (error) {
      _fail(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _manual() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = null;
      _connected = false;
    });
    try {
      await widget.host.configureHub(
        url: _url.text.trim(),
        token: _token.text.trim(),
      );
      _token.clear();
      await _finish();
    } catch (error) {
      _fail(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _finish() async {
    if (!mounted) return;
    setState(() {
      _connected = true;
      _message = _text(
        '连接已保存，正在同步。你可以离开此页面。',
        'Connection saved. Syncing now; you can leave this page.',
      );
    });
    unawaited(
      widget.host.sync().then(
        (_) {
          if (mounted) {
            setState(
              () => _message = _text('已连接并完成同步。', 'Connected and synced.'),
            );
          }
        },
        onError: (Object _) {
          if (mounted) {
            setState(
              () => _message = _text(
                '连接已保存。当前同步暂未完成，可稍后重试。',
                'Connection saved. Sync has not finished yet; try again later.',
              ),
            );
          }
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: Scaffold(
      appBar: AppBar(title: Text(_text('连接同步 Hub', 'Connect sync Hub'))),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text(
            _text(
              '在 Mac 的 Nova 设置中打开「手机同步 Hub」，启用后台同步，然后扫描二维码。',
              'Open Mobile sync Hub in Nova settings on your Mac, enable background sync, then scan its QR code.',
            ),
          ),
          const SizedBox(height: 12),
          Text(
            _text(
              '两端需要连接同一 Tailscale 网络。Android 通常只能使用一个 VPN；如果正在使用其他 VPN，请先自行确认连接方式。',
              'Both devices need the same Tailscale network. Android normally supports one VPN at a time. If another VPN is running, check your connection setup first.',
            ),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _deviceName,
            enabled: !_busy,
            maxLength: 100,
            decoration: InputDecoration(
              labelText: _text('这台手机的名称', 'This phone’s name'),
            ),
          ),
          if (Platform.isAndroid || widget.scanCode != null)
            FilledButton.icon(
              onPressed: _busy ? null : _scan,
              icon: const Icon(Icons.qr_code_scanner),
              label: Text(_text('扫描 Mac 二维码', 'Scan Mac QR code')),
            )
          else
            Text(
              _text(
                '扫码连接目前支持 Android。',
                'QR pairing currently supports Android.',
              ),
            ),
          if (_busy)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: CircularProgressIndicator()),
            ),
          if (_message != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Text(
                _message!,
                key: const Key('hub-result'),
                style: TextStyle(
                  color: _connected
                      ? Theme.of(context).colorScheme.primary
                      : Theme.of(context).colorScheme.error,
                ),
              ),
            ),
          if (widget.host.repo?.accountId != null)
            Text(
              _text(
                '本机资料已绑定 Hub；不能直接切换到其他账号或 Hub。',
                'Local data is already bound to a Hub. Switching to another account or Hub is not supported.',
              ),
            ),
          const SizedBox(height: 24),
          ExpansionTile(
            title: Text(_text('高级：手动连接', 'Advanced: manual connection')),
            children: [
              TextField(
                controller: _url,
                enabled: !_busy,
                autocorrect: false,
                decoration: InputDecoration(
                  labelText: _text('Hub HTTPS 地址', 'Hub HTTPS address'),
                ),
              ),
              TextField(
                controller: _token,
                enabled: !_busy,
                obscureText: true,
                autocorrect: false,
                enableSuggestions: false,
                decoration: InputDecoration(
                  labelText: _text('设备令牌', 'Device token'),
                ),
              ),
              const SizedBox(height: 12),
              Text(
                _text(
                  '只连接你信任的 Hub。保存后将同步本机事项资料。',
                  'Connect only to a Hub you trust. Saving enables sync of local tasks, ideas and goals.',
                ),
              ),
              TextButton(
                onPressed: _busy ? null : _manual,
                child: Text(_text('允许同步这些资料', 'Allow syncing this data')),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}
