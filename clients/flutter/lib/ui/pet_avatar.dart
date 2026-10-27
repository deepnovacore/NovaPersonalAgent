import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'theme.dart';

/// Approved public character media, kept byte-identical to the reviewed copy.
const petAvatarAsset = 'assets/pets/nova.png';

/// Preference key holding `{"mode":"default"|"custom","path":...}` as JSON.
const petAvatarPreferenceKey = 'nova.petAvatar';

/// Largest accepted gallery file; larger images are rejected before decode.
const petAvatarMaxInputBytes = 8 * 1024 * 1024;

/// Longest edge of the PNG written to the app-support directory.
const petAvatarMaxDimension = 512;

/// Versioned prefix written under the application-support directory. A new
/// file name makes Flutter's FileImage cache see a new provider identity.
const petAvatarFilePrefix = 'pet-avatar-';

/// Legacy fixed name from before versioned writes; still cleaned up on reset.
const petAvatarLegacyFileName = 'pet-avatar.png';

/// Raised when a picked image cannot be decoded, resized or encoded.
class PetAvatarFailure implements Exception {
  const PetAvatarFailure(this.code);
  final String code;
  @override
  String toString() => 'PetAvatarFailure($code)';
}

/// Decodes [bytes] and returns a PNG whose longest edge is at most
/// [petAvatarMaxDimension]. Images already within the bound are not upscaled.
///
/// The image is decoded directly at the target size so an oversized gallery
/// photo never occupies its full decoded memory footprint.
Future<Uint8List> scalePetAvatarPng(Uint8List bytes) async {
  if (bytes.isEmpty) throw const PetAvatarFailure('image_decode_failed');
  ui.ImmutableBuffer? buffer;
  ui.ImageDescriptor? descriptor;
  try {
    buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
    descriptor = await ui.ImageDescriptor.encoded(buffer);
  } catch (_) {
    descriptor?.dispose();
    buffer?.dispose();
    throw const PetAvatarFailure('image_decode_failed');
  }
  final width = descriptor.width, height = descriptor.height;
  descriptor.dispose();
  buffer.dispose();
  if (width <= 0 || height <= 0) {
    throw const PetAvatarFailure('image_decode_failed');
  }
  final longest = math.max(width, height);
  final scale = longest > petAvatarMaxDimension
      ? petAvatarMaxDimension / longest
      : 1.0;
  final targetWidth = math.max(1, (width * scale).round());
  final targetHeight = math.max(1, (height * scale).round());
  ui.Codec? codec;
  ui.Image? image;
  try {
    codec = scale < 1.0
        ? await ui.instantiateImageCodec(
            bytes,
            targetWidth: targetWidth,
            targetHeight: targetHeight,
          )
        : await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    image = frame.image;
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) throw const PetAvatarFailure('image_encode_failed');
    return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  } on PetAvatarFailure {
    rethrow;
  } catch (_) {
    throw const PetAvatarFailure('image_decode_failed');
  } finally {
    image?.dispose();
    codec?.dispose();
  }
}

/// Owns the selected pet avatar, persisted locally as JSON in
/// [shared_preferences] and as a resized PNG in the application-support
/// directory. Nothing leaves this device.
class PetAvatarStore extends ChangeNotifier {
  factory PetAvatarStore({
    Future<Directory> Function()? supportDirectory,
    Future<Uint8List?> Function()? pickImage,
  }) => PetAvatarStore._(
    supportDirectory ?? getApplicationSupportDirectory,
    pickImage,
  );

  PetAvatarStore._(this._supportDirectory, this._pickImage);

  final Future<Directory> Function() _supportDirectory;
  final Future<Uint8List?> Function()? _pickImage;

  bool _loaded = false, _busy = false, _disposed = false;
  String? _customPath, _error;
  int _revision = 0;

  /// Whether the persisted value has been read.
  bool get loaded => _loaded;

  /// Whether a pick/resize/write is in progress.
  bool get busy => _busy;

  /// Absolute path of the resized custom PNG, or null for the default avatar.
  String? get customPath => _customPath;

  /// Last failure code (`image_too_large`, `image_decode_failed`, ...).
  String? get error => _error;

  bool get hasCustom => _customPath != null;

  String get mode => hasCustom ? 'custom' : 'default';

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Reads the persisted value. Malformed JSON, unknown modes, missing paths
  /// and missing files all fall back to the default avatar.
  Future<void> load() async {
    if (_loaded || _disposed) return;
    final revision = _revision;
    String? path;
    try {
      final preferences = await SharedPreferences.getInstance();
      final raw = preferences.getString(petAvatarPreferenceKey);
      if (raw != null && raw.isNotEmpty) {
        path = await _pathFromPreferences(preferences, raw);
      }
    } catch (_) {
      path = null;
    }
    if (_disposed || revision != _revision) return;
    _customPath = path;
    _loaded = true;
    _notify();
  }

  Future<String?> _pathFromPreferences(
    SharedPreferences preferences,
    String raw,
  ) async {
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      await preferences.remove(petAvatarPreferenceKey);
      return null;
    }
    if (decoded is! Map) {
      await preferences.remove(petAvatarPreferenceKey);
      return null;
    }
    final mode = decoded['mode'];
    if (mode == 'default') return null;
    final path = decoded['path'];
    if (mode != 'custom' || path is! String || path.trim().isEmpty) {
      await preferences.remove(petAvatarPreferenceKey);
      return null;
    }
    final file = File(path);
    if (!await file.exists() || await file.length() == 0) {
      await preferences.remove(petAvatarPreferenceKey);
      return null;
    }
    return path;
  }

  Future<void> _persist() async {
    try {
      final preferences = await SharedPreferences.getInstance();
      await preferences.setString(
        petAvatarPreferenceKey,
        jsonEncode({'mode': mode, 'path': _customPath}),
      );
    } catch (_) {
      // The chosen avatar still renders for this session.
    }
  }

  /// Opens the photo library, validates, resizes and installs the picked image.
  ///
  /// Returns true only when a new avatar was written. Cancelling the picker
  /// returns false without an error; failures set [error].
  Future<bool> pickCustomImage() async {
    if (_busy || _disposed) return false;
    _busy = true;
    _error = null;
    _notify();
    try {
      final bytes = await (_pickImage ?? _pickFromGallery)();
      if (bytes == null) return false;
      if (bytes.length > petAvatarMaxInputBytes) {
        _error = 'image_too_large';
        return false;
      }
      final png = await scalePetAvatarPng(bytes);
      final directory = await _supportDirectory();
      await directory.create(recursive: true);
      // Write a brand-new versioned file first: a failed write never truncates
      // the current avatar, and a successful one gives FileImage a new identity.
      final next = File(
        '${directory.path}${Platform.pathSeparator}$petAvatarFilePrefix${DateTime.now().microsecondsSinceEpoch}.png',
      );
      try {
        await next.writeAsBytes(png, flush: true);
      } catch (_) {
        try {
          await next.delete();
        } catch (_) {
          // A partial file is best-effort cleanup; the old avatar is untouched.
        }
        rethrow;
      }
      final previous = _customPath;
      _customPath = next.path;
      _revision++;
      await _persist();
      if (previous != null && previous != next.path) {
        await _deleteAvatarFile(previous);
      }
      return true;
    } on PetAvatarFailure catch (failure) {
      _error = failure.code;
      return false;
    } catch (_) {
      _error = 'image_failed';
      return false;
    } finally {
      _busy = false;
      _notify();
    }
  }

  Future<Uint8List?> _pickFromGallery() async {
    final picked = await ImagePicker().pickImage(source: ImageSource.gallery);
    if (picked == null) return null;
    if (await picked.length() > petAvatarMaxInputBytes) {
      throw const PetAvatarFailure('image_too_large');
    }
    return picked.readAsBytes();
  }

  /// Restores the default avatar and deletes the resized custom PNG.
  Future<void> resetToDefault() async {
    if (_disposed) return;
    final previous = _customPath;
    _customPath = null;
    _error = null;
    _revision++;
    _notify();
    await _persist();
    if (previous != null) await _deleteAvatarFile(previous);
  }

  /// Deletes only files this store owns, never an arbitrary persisted path.
  Future<void> _deleteAvatarFile(String path) async {
    final name = path.split(Platform.pathSeparator).last;
    if (!name.startsWith(petAvatarFilePrefix) &&
        name != petAvatarLegacyFileName) {
      return;
    }
    try {
      final file = File(path);
      if (await file.exists()) await file.delete();
    } catch (_) {
      // The file may already be gone or on read-only storage.
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// Renders the configured pet avatar at a fixed [size], falling back to the
/// approved default asset when no custom file exists or the file is corrupt.
class PetAvatar extends StatelessWidget {
  const PetAvatar({
    super.key,
    required this.store,
    this.size = 64,
    this.borderRadius,
  });

  final PetAvatarStore store;
  final double size;
  final BorderRadius? borderRadius;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) {
      // Decode only as many pixels as the square is painted at.
      final decodeWidth = math.max(
        1,
        (size * MediaQuery.devicePixelRatioOf(context)).ceil(),
      );
      final fallback = _defaultImage(decodeWidth);
      final path = store.customPath;
      final Widget image;
      // A missing file falls back immediately; a corrupt file fails inside
      // Image.file and uses the same error builder.
      if (path != null && File(path).existsSync()) {
        image = Image.file(
          File(path),
          width: size,
          height: size,
          fit: BoxFit.cover,
          cacheWidth: decodeWidth,
          gaplessPlayback: true,
          filterQuality: FilterQuality.medium,
          errorBuilder: (_, _, _) => fallback,
        );
      } else {
        image = fallback;
      }
      return Semantics(
        image: true,
        label: 'Nova',
        child: ClipRRect(
          borderRadius: borderRadius ?? BorderRadius.circular(size * .28),
          child: SizedBox.square(dimension: size, child: image),
        ),
      );
    },
  );

  Widget _defaultImage(int decodeWidth) => Image.asset(
    petAvatarAsset,
    width: size,
    height: size,
    fit: BoxFit.cover,
    cacheWidth: decodeWidth,
    filterQuality: FilterQuality.medium,
    errorBuilder: (_, _, _) => ColoredBox(
      color: Nova.cell,
      child: Center(
        child: Icon(
          CupertinoIcons.person_fill,
          size: size * .55,
          color: Nova.tertiary,
        ),
      ),
    ),
  );
}

/// The app-bar identity: the pet avatar and the assistant name on one row.
/// Tapping it opens the same avatar settings as the Settings entry.
class PetAvatarTitle extends StatelessWidget {
  const PetAvatarTitle({
    super.key,
    required this.store,
    this.language = 'zh',
    this.title = 'Nova',
  });

  final PetAvatarStore store;
  final String language;
  final String title;

  @override
  Widget build(BuildContext context) {
    final label = language == 'zh' ? 'Nova · 宠物头像' : 'Nova · Pet avatar';
    return Semantics(
      button: true,
      label: label,
      child: Tooltip(
        message: language == 'zh' ? '宠物头像' : 'Pet avatar',
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () =>
              showPetAvatarSettings(context, store, language: language),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                PetAvatar(store: store, size: 30),
                const SizedBox(width: 8),
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -.5,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Opens the pet avatar settings sheet.
Future<void> showPetAvatarSettings(
  BuildContext context,
  PetAvatarStore store, {
  String language = 'zh',
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  backgroundColor: Nova.sheet,
  builder: (context) =>
      _PetAvatarSettingsSheet(store: store, language: language),
);

class _PetAvatarSettingsSheet extends StatelessWidget {
  const _PetAvatarSettingsSheet({required this.store, required this.language});

  final PetAvatarStore store;
  final String language;

  String _errorText(String code, String Function(String, String) t) =>
      switch (code) {
        'image_too_large' => t(
          '图片超过 8 MB，请选择更小的图片。',
          'The image is larger than 8 MB. Choose a smaller one.',
        ),
        'image_decode_failed' || 'image_encode_failed' => t(
          '无法读取这张图片，请换一张。',
          'Could not read this image. Try another one.',
        ),
        _ => t('未能保存头像，请重试。', 'Could not save the avatar. Please retry.'),
      };

  @override
  Widget build(BuildContext context) {
    String t(String zh, String en) => language == 'zh' ? zh : en;
    return SingleChildScrollView(
      child: ListenableBuilder(
        listenable: store,
        builder: (context, _) {
          final error = store.error;
          return Padding(
            padding: const EdgeInsets.fromLTRB(20, 10, 20, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 36,
                  height: 5,
                  decoration: BoxDecoration(
                    color: Nova.separator,
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
                const SizedBox(height: 16),
                Text(
                  t('宠物头像', 'Pet avatar'),
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 16),
                PetAvatar(store: store, size: 96),
                const SizedBox(height: 10),
                Text(
                  t('仅保存在本机', 'Saved on this device only'),
                  style: const TextStyle(fontSize: 12, color: Nova.secondary),
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      _errorText(error, t),
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 13, color: Nova.red),
                    ),
                  ),
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: store.busy ? null : store.pickCustomImage,
                    icon: const Icon(CupertinoIcons.photo, size: 18),
                    label: Text(t('从相册选择', 'Choose image')),
                  ),
                ),
                const SizedBox(height: 8),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton.icon(
                    onPressed: store.busy || !store.hasCustom
                        ? null
                        : store.resetToDefault,
                    icon: const Icon(
                      CupertinoIcons.arrow_counterclockwise,
                      size: 18,
                    ),
                    label: Text(t('恢复默认', 'Restore default')),
                  ),
                ),
                if (store.busy)
                  const Padding(
                    padding: EdgeInsets.only(top: 12),
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                const SizedBox(height: 4),
                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: Text(t('完成', 'Done')),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}
