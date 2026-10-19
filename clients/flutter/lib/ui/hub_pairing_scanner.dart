import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class HubPairingScanner extends StatefulWidget {
  const HubPairingScanner({super.key, this.language = 'zh'});
  final String language;
  @override
  State<HubPairingScanner> createState() => _HubPairingScannerState();
}

class _HubPairingScannerState extends State<HubPairingScanner>
    with WidgetsBindingObserver {
  final _controller = MobileScannerController(
    formats: [BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  bool _captured = false;
  String _text(String zh, String en) => widget.language == 'zh' ? zh : en;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!_controller.value.hasCameraPermission || _captured) return;
    if (state == AppLifecycleState.resumed) {
      unawaited(_controller.start().catchError((_) {}));
    } else {
      unawaited(_controller.stop().catchError((_) {}));
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_controller.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(_text('扫描 Mac 二维码', 'Scan Mac QR code'))),
    body: MobileScanner(
      controller: _controller,
      onDetect: (capture) {
        if (_captured || !mounted) return;
        for (final barcode in capture.barcodes) {
          final raw = barcode.rawValue;
          if (raw != null) {
            _captured = true;
            unawaited(_controller.stop().catchError((_) {}));
            Navigator.pop(context, raw);
            break;
          }
        }
      },
      errorBuilder: (context, error) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            error.errorCode == MobileScannerErrorCode.permissionDenied
                ? _text(
                    '相机权限未开启，请在 Android 设置中允许 Nova 使用相机后重试。',
                    'Camera permission is off. Allow Nova to use the camera in Android settings, then try again.',
                  )
                : _text(
                    '无法打开相机，请返回后重试。',
                    'Cannot open the camera. Go back and try again.',
                  ),
          ),
        ),
      ),
    ),
  );
}
