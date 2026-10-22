import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';
import 'package:ffi/ffi.dart';
import '../protocol/request_id.dart';

// Darwin arm64 and Android/Linux arm64 use different open/stat/dirent ABIs.
// No guest path is ever passed as an absolute host path after opening root.
final class WorkspaceDirectory {
  WorkspaceDirectory._(this.fd);
  final int fd;
  bool _closed = false;
  static final _lib = DynamicLibrary.process();
  static final _darwin = Platform.isMacOS || Platform.isIOS;
  static final _openat = _lib
      .lookupFunction<
        Int32 Function(Int32, Pointer<Utf8>, Int32, VarArgs<(Int32,)>),
        int Function(int, Pointer<Utf8>, int, int)
      >('openat');
  static final _close = _lib
      .lookupFunction<Int32 Function(Int32), int Function(int)>('close');
  static final _mkdirat = _lib
      .lookupFunction<
        Int32 Function(Int32, Pointer<Utf8>, Uint32),
        int Function(int, Pointer<Utf8>, int)
      >('mkdirat');
  static final _renameat = _lib
      .lookupFunction<
        Int32 Function(Int32, Pointer<Utf8>, Int32, Pointer<Utf8>),
        int Function(int, Pointer<Utf8>, int, Pointer<Utf8>)
      >('renameat');
  static final _linkat = _lib
      .lookupFunction<
        Int32 Function(Int32, Pointer<Utf8>, Int32, Pointer<Utf8>, Int32),
        int Function(int, Pointer<Utf8>, int, Pointer<Utf8>, int)
      >('linkat');
  // Android app SELinux domains prohibit hard links. renameat2 is available
  // in the kernel on supported devices, but its libc wrapper requires API 30.
  static final _syscall = _lib
      .lookupFunction<
        IntPtr Function(
          IntPtr,
          VarArgs<(Int32, Pointer<Utf8>, Int32, Pointer<Utf8>, Uint32)>,
        ),
        int Function(int, int, Pointer<Utf8>, int, Pointer<Utf8>, int)
      >('syscall');
  static int _installMissing(
    int directory,
    Pointer<Utf8> from,
    Pointer<Utf8> to,
  ) {
    if (!Platform.isAndroid) return _linkat(directory, from, directory, to, 0);
    final renameat2 = switch (Abi.current()) {
      Abi.androidArm64 => 276,
      Abi.androidArm => 382,
      Abi.androidX64 => 316,
      Abi.androidIA32 => 353,
      _ => throw UnsupportedError('Unsupported Android filesystem ABI'),
    };
    return _syscall(
      renameat2,
      directory,
      from,
      directory,
      to,
      1,
    ); // RENAME_NOREPLACE
  }

  static final _unlinkat = _lib
      .lookupFunction<
        Int32 Function(Int32, Pointer<Utf8>, Int32),
        int Function(int, Pointer<Utf8>, int)
      >('unlinkat');
  static final _read = _lib
      .lookupFunction<
        IntPtr Function(Int32, Pointer<Uint8>, UintPtr),
        int Function(int, Pointer<Uint8>, int)
      >('read');
  static final _write = _lib
      .lookupFunction<
        IntPtr Function(Int32, Pointer<Uint8>, UintPtr),
        int Function(int, Pointer<Uint8>, int)
      >('write');
  static final _fsync = _lib
      .lookupFunction<Int32 Function(Int32), int Function(int)>('fsync');
  static final _fstat = _lib
      .lookupFunction<
        Int32 Function(Int32, Pointer<Void>),
        int Function(int, Pointer<Void>)
      >(_darwin && Abi.current() == Abi.macosX64 ? r'fstat$INODE64' : 'fstat');
  static final _fdopendir = _lib
      .lookupFunction<
        Pointer<Void> Function(Int32),
        Pointer<Void> Function(int)
      >('fdopendir');
  static final _readdir = _lib
      .lookupFunction<
        Pointer<Uint8> Function(Pointer<Void>),
        Pointer<Uint8> Function(Pointer<Void>)
      >(
        _darwin && Abi.current() == Abi.macosX64
            ? r'readdir$INODE64'
            : 'readdir',
      );
  static final _closedir = _lib
      .lookupFunction<
        Int32 Function(Pointer<Void>),
        int Function(Pointer<Void>)
      >('closedir');
  static final _errno = _lib
      .lookupFunction<Pointer<Int32> Function(), Pointer<Int32> Function()>(
        _darwin
            ? '__error'
            : Platform.isAndroid
            ? '__errno'
            : '__errno_location',
      );
  // Linux arm64 overrides asm-generic/fcntl.h: using the x86 directory
  // bit here requests O_DIRECT instead and fails with EINVAL on directories.
  static bool get _linuxArm64 =>
      Abi.current() == Abi.androidArm64 || Abi.current() == Abi.linuxArm64;
  static int get _directory => _darwin
      ? 0x100000
      : _linuxArm64
      ? 0x4000
      : 0x10000;
  static int get _safe =>
      (_darwin
          ? 0x100
          : _linuxArm64
          ? 0x8000
          : 0x20000) |
      (_darwin ? 0x1000000 : 0x80000);
  static int get _nonblock => _darwin ? 4 : 0x800;
  static int get _createExclusive => _darwin ? 0x200 | 0x800 : 0x40 | 0x80;
  static Never _fail([int? code]) => throw FileSystemException(
    'Workspace filesystem operation failed',
    '',
    OSError('', code ?? _errno().value),
  );
  static void _name(String name) {
    if (name.isEmpty ||
        name == '.' ||
        name == '..' ||
        name.contains('/') ||
        name.contains('\u0000')) {
      throw const FileSystemException('Invalid workspace component');
    }
  }

  static int _open(int parent, String name, int flags) {
    final text = name.toNativeUtf8();
    try {
      final result = _openat(parent, text, flags, 0x180); // owner read/write
      if (result < 0) _fail();
      return result;
    } finally {
      calloc.free(text);
    }
  }

  factory WorkspaceDirectory.openRoot(String path) => WorkspaceDirectory._(
    _open(_darwin ? -2 : -100, path, _safe | _directory),
  );
  WorkspaceDirectory child(String name, {bool create = false}) {
    _name(name);
    if (create) {
      final text = name.toNativeUtf8();
      try {
        if (_mkdirat(fd, text, 0x1c0) < 0 && _errno().value != 17) _fail();
      } finally {
        calloc.free(text);
      }
    }
    return WorkspaceDirectory._(_open(fd, name, _safe | _directory));
  }

  void close() {
    if (!_closed) {
      _closed = true;
      _close(fd);
    }
  }

  static ({int kind, int size}) _stat(int handle) {
    final buffer = calloc<Uint8>(256);
    try {
      if (_fstat(handle, buffer.cast()) < 0) _fail();
      final mode = _darwin
          ? (buffer + 4).cast<Uint16>().value
          : (buffer +
                    ((Abi.current() == Abi.linuxX64 ||
                            Abi.current() == Abi.androidX64)
                        ? 24
                        : 16))
                .cast<Uint32>()
                .value;
      final size = (buffer + (_darwin ? 96 : 48)).cast<Int64>().value;
      return (kind: mode & 0xf000, size: size);
    } finally {
      calloc.free(buffer);
    }
  }

  WorkspaceFile file(String name) {
    _name(name);
    final handle = _open(fd, name, _safe | _nonblock);
    try {
      final info = _stat(handle);
      if (info.kind != 0x8000) {
        throw const FileSystemException('Not a regular workspace file');
      }
      return WorkspaceFile._(handle, info.size);
    } catch (_) {
      _close(handle);
      rethrow;
    }
  }

  bool exists(String name) {
    _name(name);
    // O_NOFOLLOW makes a symlink an error, never a destination to inspect.
    try {
      final handle = _open(fd, name, _safe | _nonblock);
      _close(handle);
      return true;
    } on FileSystemException catch (error) {
      if (error.osError?.errorCode == 2) return false;
      rethrow;
    }
  }

  Map<String, dynamic> listing({int offset = 1, int limit = 2000}) {
    final copy = _open(fd, '.', _safe | _directory);
    final directory = _fdopendir(copy);
    if (directory == nullptr) {
      final code = _errno().value;
      _close(copy);
      _fail(code);
    }
    final entries = <Map<String, dynamic>>[];
    var index = 0, more = false;
    try {
      while (true) {
        _errno().value = 0;
        final item = _readdir(directory);
        if (item == nullptr) {
          if (_errno().value != 0) _fail();
          break;
        }
        final name = (item + (_darwin ? 21 : 19)).cast<Utf8>().toDartString();
        if (name == '.' || name == '..') continue;
        if (++index < offset) continue;
        if (entries.length == limit) {
          more = true;
          break;
        }
        final type = (item + (_darwin ? 20 : 18)).value;
        entries.add({
          'name': name,
          'type': switch (type) {
            4 => 'directory',
            8 => 'file',
            10 => 'link',
            _ => 'unknown',
          },
        });
      }
    } finally {
      _closedir(directory);
    }
    return {'type': 'directory', 'entries': entries, 'truncated': more};
  }

  void atomicWrite(String name, List<int> bytes, {bool onlyIfMissing = false}) {
    _name(name);
    final temporary = '.nova-${requestId()}.tmp';
    final temp = temporary.toNativeUtf8(), target = name.toNativeUtf8();
    var handle = -1;
    var created = false;
    try {
      handle = _open(fd, temporary, _safe | 1 | _createExclusive);
      created = true;
      final buffer = calloc<Uint8>(bytes.isEmpty ? 1 : bytes.length);
      try {
        buffer.asTypedList(bytes.length).setAll(0, bytes);
        var written = 0;
        while (written < bytes.length) {
          final count = _write(
            handle,
            buffer + written,
            bytes.length - written,
          );
          if (count < 0 && _errno().value == 4) continue;
          if (count <= 0) _fail();
          written += count;
        }
        if (_fsync(handle) < 0) _fail();
      } finally {
        calloc.free(buffer);
      }
      _close(handle);
      handle = -1;
      if (onlyIfMissing) {
        // Atomic no-overwrite install; a concurrently created/edited target wins.
        if (_installMissing(fd, temp, target) < 0 && _errno().value != 17) {
          _fail();
        }
      } else if (_renameat(fd, temp, fd, target) < 0) {
        _fail();
      }
    } finally {
      if (handle >= 0) _close(handle);
      if (created) _unlinkat(fd, temp, 0);
      calloc.free(temp);
      calloc.free(target);
    }
  }
}

final class WorkspaceFile {
  WorkspaceFile._(this.fd, this.length);
  final int fd, length;
  bool _closed = false;
  Uint8List read(int count) {
    final buffer = calloc<Uint8>(count);
    try {
      int size;
      do {
        size = WorkspaceDirectory._read(fd, buffer, count);
      } while (size < 0 && WorkspaceDirectory._errno().value == 4);
      if (size < 0) WorkspaceDirectory._fail();
      return Uint8List.fromList(buffer.asTypedList(size));
    } finally {
      calloc.free(buffer);
    }
  }

  Uint8List readAll(int maxBytes) {
    if (length > maxBytes) {
      throw const FileSystemException('Workspace file too large');
    }
    final result = BytesBuilder(copy: false);
    while (true) {
      final bytes = read(32768);
      if (bytes.isEmpty) return result.takeBytes();
      if (result.length + bytes.length > maxBytes) {
        throw const FileSystemException('Workspace file too large');
      }
      result.add(bytes);
    }
  }

  void close() {
    if (!_closed) {
      _closed = true;
      WorkspaceDirectory._close(fd);
    }
  }
}
