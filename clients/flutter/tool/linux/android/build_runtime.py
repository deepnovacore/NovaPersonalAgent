#!/usr/bin/env python3
"""Build the pinned arm64 Android Linux runtime into an explicit external directory.

Adapted build flags/talloc compatibility shim from OpenMinis deps/build_proot.sh
at b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c (GPL-3.0). No generated binaries
or downloads are written to the checkout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import zipfile

PROOT_REV = '1b444ee1cb2f4896c08166e9a12c905af5416f1c'
TERMUX_REV = '4dba3afbf3a63af89b4d9c1a59bf2bda10f4d10f'
OPENMINIS_REV = 'b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c'
ROOTFS_SHA = '6bf491907b705caa5fc65773fbbc1d0954530b6c455d4446f670a4c1fdcea489'
SOURCES = {
    'proot-1b444ee.tar.gz': (f'https://codeload.github.com/OpenMinis/proot/tar.gz/{PROOT_REV}', 'ff7a92ea5bd7d0a9ab34573762f14f9ff4c6b5915ff877b7f01e943edf0ce414'),
    'talloc-2.4.2.tar.gz': ('https://download.samba.org/pub/talloc/talloc-2.4.2.tar.gz', '85ecf9e465e20f98f9950a52e9a411e14320bc555fa257d87697b7e7a9b1d8a6'),
    'alpine-minirootfs-3.22.2-aarch64.tar.gz': ('https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/aarch64/alpine-minirootfs-3.22.2-aarch64.tar.gz', ROOTFS_SHA),
    'termux-proot-4dba3af.zip': (f'https://codeload.github.com/termux/proot/zip/{TERMUX_REV}', 'a72668607184f981e44181bfa47f86ef52d52bb237b4012ee94f0dc89cb39211'),
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--external-root', type=Path, required=True, help='Mounted external disk (must be a mount point)')
    parser.add_argument('--session-root', type=Path, required=True, help='Unique worktree/chat build namespace beneath external-root')
    parser.add_argument('--ndk', type=Path, required=True)
    args = parser.parse_args()
    external = args.external_root.resolve()
    # pathlib misses same-device bind mounts used by managed workspaces.
    mounted = external.is_mount() or (platform.system() == 'Linux' and shutil.which('mountpoint') is not None and
        subprocess.run(['mountpoint', '-q', str(external)]).returncode == 0)
    if not mounted:
        parser.error('external-root is not mounted; refusing internal-disk fallback')
    session = args.session_root.resolve()
    if not session.is_relative_to(external) or session == external:
        parser.error('session-root must be a unique namespace below external-root')
    sources = session / 'native-sources/android'
    build = session / 'native-build/android'
    output = session / 'android/linux-runtime'
    for path in [sources, build, output]: path.mkdir(parents=True, exist_ok=True)
    for name, (url, expected) in SOURCES.items():
        destination = sources / name
        if not destination.exists():
            partial = destination.with_suffix(destination.suffix + '.partial')
            subprocess.run(['curl', '-fL', '--retry', '3', '--connect-timeout', '30', url, '-o', str(partial)], check=True)
            partial.replace(destination)
        actual = hashlib.sha256(destination.read_bytes()).hexdigest()
        if actual != expected: raise RuntimeError(f'Checksum mismatch: {name}: {actual}')
    proot = build / f'proot-{PROOT_REV}'
    talloc = build / 'talloc-2.4.2'
    for archive, directory in [('proot-1b444ee.tar.gz', proot), ('talloc-2.4.2.tar.gz', talloc)]:
        if not directory.exists():
            with tarfile.open(sources / archive) as stream: stream.extractall(build, filter='data')
    host = 'darwin-x86_64' if platform.system() == 'Darwin' else 'linux-x86_64'
    toolchain = args.ndk / 'toolchains/llvm/prebuilt' / host / 'bin'
    cc = toolchain / 'aarch64-linux-android24-clang'
    if not cc.is_file(): raise RuntimeError('NDK aarch64 clang not found')
    (talloc / 'replace.h').write_text('''#ifndef REPLACE_H
#define REPLACE_H
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <stdbool.h>
#include <errno.h>
#include <unistd.h>
#include <sys/types.h>
#include <sys/auxv.h>
#define TALLOC_BUILD_VERSION_MAJOR 2
#define TALLOC_BUILD_VERSION_MINOR 4
#define TALLOC_BUILD_VERSION_RELEASE 2
#define HAVE_SYS_AUXV_H 1
#define HAVE_INTPTR_T 1
#define HAVE_VA_COPY 1
#define HAVE_CONSTRUCTOR_ATTRIBUTE 1
#define VALGRIND_MAKE_MEM_UNDEFINED(p,n) do { (void)(p); (void)(n); } while(0)
#define VALGRIND_MAKE_MEM_DEFINED(p,n) do { (void)(p); (void)(n); } while(0)
#define VALGRIND_MAKE_MEM_NOACCESS(p,n) do { (void)(p); (void)(n); } while(0)
#define ZERO_STRUCT(x) memset((char *)&(x),0,sizeof(x))
#define discard_const(ptr) ((void *)((uintptr_t)(ptr)))
#define MIN(a,b) ((a)<(b)?(a):(b))
#define MAX(a,b) ((a)>(b)?(a):(b))
#endif
''')
    subprocess.run([str(cc), '-c', str(talloc / 'talloc.c'), '-o', str(build / 'talloc.o'), '-I' + str(talloc), '-fPIC', '-O2', '-std=gnu99', '-DHAVE_STDARG_H=1', '-DHAVE_VA_COPY=1', '-DHAVE_UNISTD_H=1', '-DHAVE_INTPTR_T=1'], check=True)
    subprocess.run([str(toolchain / 'llvm-ar'), 'rcs', str(build / 'libtalloc.a'), str(build / 'talloc.o')], check=True)
    # The pinned loader awk uses GNU strtonum/word-boundaries. Use a POSIX
    # equivalent so the documented Linux build works with mawk as well.
    (proot / 'src/loader/loader-info.awk').write_text('''function hex(s, n,i,c) { n=0; for(i=1;i<=length(s);i++){c=index("0123456789abcdef",tolower(substr(s,i,1)))-1;if(c<0)return 0;n=n*16+c}return n }
$8 == "pokedata_workaround" { pokedata_workaround=hex($2) }
$8 == "_start" { start=hex($2) }
END { print "#include <unistd.h>"; print "const ssize_t offset_to_pokedata_workaround=" (pokedata_workaround-start) ";" }
''')
    subprocess.run(['make', '-j4', 'CC=' + str(cc), 'STRIP=' + str(toolchain / 'llvm-strip'), 'OBJCOPY=' + str(toolchain / 'llvm-objcopy'), 'OBJDUMP=' + str(toolchain / 'llvm-objdump'), f'CPPFLAGS=-D_FILE_OFFSET_BITS=64 -D_GNU_SOURCE -I. -DARG_MAX=131072 -I{talloc}', 'CFLAGS=-O2 -Wall -Wextra -fPIE', f'LDFLAGS=-Wl,-z,noexecstack -Wl,-z,max-page-size=16384 -pie -L{build} -ltalloc'], cwd=proot / 'src', check=True)
    libs = output / 'jniLibs/arm64-v8a'
    assets = output / 'assets/nova-linux'
    licenses = assets / 'licenses'
    libs.mkdir(parents=True, exist_ok=True); licenses.mkdir(parents=True, exist_ok=True)
    shutil.copy2(proot / 'src/proot', libs / 'libproot.so')
    termux = build / f'proot-{TERMUX_REV}'
    if not termux.exists():
        with zipfile.ZipFile(sources / 'termux-proot-4dba3af.zip') as archive: archive.extractall(build)
    subprocess.run(['make', 'loader/loader', 'CC=' + str(cc), 'STRIP=' + str(toolchain / 'llvm-strip'), f'CPPFLAGS=-D_FILE_OFFSET_BITS=64 -D_GNU_SOURCE -I. -DARG_MAX=131072 -I{talloc}', 'CFLAGS=-O2 -Wall -Wextra -fPIE', 'BUILD_ID_NONE=,--build-id=none'], cwd=termux / 'src', check=True)
    shutil.copy2(termux / 'src/loader/loader', libs / 'libproot-loader.so')
    repo = Path(__file__).resolve().parents[5]
    subprocess.run([str(cc), '-O2', '-fPIE', '-pie', '-Wl,-z,max-page-size=16384', '-o', str(libs / 'libnova-exec.so'), str(repo / 'clients/flutter/android/app/src/main/c/nova_exec.c')], check=True)
    for name in ['libproot.so', 'libnova-exec.so', 'libproot-loader.so']:
        subprocess.run([str(toolchain / 'llvm-strip'), str(libs / name)], check=True)
    for binary in libs.glob('*.so'):
        data = binary.read_bytes()
        if data[:4] != b'\x7fELF' or int.from_bytes(data[18:20], 'little') != 183:
            raise RuntimeError(f'Not an ARM64 ELF executable: {binary}')
        binary.chmod(0o755)
    shutil.copy2(sources / 'alpine-minirootfs-3.22.2-aarch64.tar.gz', assets / 'rootfs.tgz')
    (assets / 'rootfs.sha256').write_text(ROOTFS_SHA + '\n')
    for directory, label in [(proot, 'proot'), (talloc, 'talloc'), (termux, 'termux-loader')]:
        for candidate in ['COPYING', 'COPYING.LESSER', 'LICENSE']:
            if (directory / candidate).is_file(): shutil.copy2(directory / candidate, licenses / f'{label}-{candidate}')
    shutil.copy2(Path(__file__).with_name('THIRD_PARTY.md'), licenses / 'THIRD_PARTY.md')
    manifest = {'architecture': 'arm64-v8a', 'proot_revision': PROOT_REV, 'loader_revision': TERMUX_REV, 'ndk': (args.ndk / 'source.properties').read_text(), 'sources': {name: {'url': url, 'sha256': sha} for name, (url, sha) in SOURCES.items()}, 'artifacts': {str(f.relative_to(output)): hashlib.sha256(f.read_bytes()).hexdigest() for f in output.rglob('*') if f.is_file()}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Runtime ready: {output}\nSet NOVA_ANDROID_LINUX_RUNTIME={output}')

if __name__ == '__main__': main()
