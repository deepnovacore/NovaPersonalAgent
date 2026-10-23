#!/usr/bin/env python3
"""Build pinned iSH ARM64 + Alpine; all generated files stay under --output-root."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tarfile, urllib.request

ISH_COMMIT = 'e6521d9cfe9cd48f19917fc3b23aea622ba358b4'
ISH_SHA256 = '48fea8b9d713c79581148b19f17d828b79e487adf7058d998aa08ef9d06fa07c'
ALPINE_SHA256 = 'f31202c4070c4ef7de9e157e1bd01cb4da3a2150035d74ea5372c5e86f1efac1'

def run(*args, **kw): subprocess.run(args, check=True, **kw)
def download(url, target, expected):
    if not target.exists():
        temporary = target.with_name(target.name + '.' + str(os.getpid()) + '.download')
        with urllib.request.urlopen(url, timeout=120) as response: temporary.write_bytes(response.read())
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != expected:
            temporary.unlink(); raise SystemExit(f'Integrity mismatch: {target.name}')
        temporary.replace(target)
    actual = hashlib.sha256(target.read_bytes()).hexdigest()
    if actual != expected: raise SystemExit(f'Integrity mismatch: {target.name}: {actual}')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-root', type=pathlib.Path, required=True)
    parser.add_argument('--sdk', choices=['iphoneos','iphonesimulator','macosx'], default='iphoneos')
    parser.add_argument('--ci-runner-temp', action='store_true', help='Allow an isolated GitHub Actions RUNNER_TEMP output root')
    args = parser.parse_args()
    out = args.output_root.resolve()
    if args.ci_runner_temp:
        runner_temp = os.environ.get('RUNNER_TEMP')
        if os.environ.get('GITHUB_ACTIONS') != 'true' or not runner_temp or not out.is_relative_to(pathlib.Path(runner_temp).resolve()) or out == pathlib.Path(runner_temp).resolve():
            raise SystemExit('--ci-runner-temp requires an isolated output under GitHub Actions RUNNER_TEMP')
    elif len(out.parts) < 4 or out.parts[1] != 'Volumes' or not os.path.ismount(pathlib.Path('/Volumes') / out.parts[2]):
        raise SystemExit('--output-root must be on a mounted external volume; no internal fallback')
    out.mkdir(parents=True, exist_ok=True)
    downloads = out / 'downloads'; downloads.mkdir(exist_ok=True)
    env = os.environ.copy(); env['TMPDIR'] = str(out / 'tmp'); pathlib.Path(env['TMPDIR']).mkdir(exist_ok=True)
    env['CLANG_MODULE_CACHE_PATH'] = str(out / 'clang-cache')
    tools = out / 'tools'
    if not (tools / 'bin/meson').exists():
        run('python3','-m','venv',str(tools),env=env)
        run(str(tools/'bin/pip'),'install','--no-cache-dir','meson==1.7.2','ninja==1.11.1.4',env=env)
    env['PATH'] = str(tools/'bin') + ':/opt/homebrew/opt/llvm/bin:' + env['PATH']
    linker = shutil.which('ld.lld', path=env['PATH'])
    if not linker:
        candidates = sorted((pathlib.Path.home()/'Library/Android/sdk/ndk').glob('*/toolchains/llvm/prebuilt/darwin-x86_64/bin/ld.lld'))
        if candidates: linker = str(candidates[-1])
    if not linker: raise SystemExit('Install LLVM lld (ELF linker); a real ARM64 VDSO is required')
    env['PATH'] += ':' + str(pathlib.Path(linker).parent)
    archive = downloads/'ish.tar.gz'
    download(f'https://api.github.com/repos/OpenMinis/ish-arm64/tarball/{ISH_COMMIT}', archive, ISH_SHA256)
    sources = out/'sources'; sources.mkdir(exist_ok=True)
    source = sources/'OpenMinis-ish-arm64-e6521d9'
    if not source.exists():
        with tarfile.open(archive) as tar: tar.extractall(sources, filter='data')
    # Darwin names this non-portable spawn action with the _np suffix.
    spawn_source = source/'kernel/native_offload.c'
    spawn_text = spawn_source.read_text()
    if 'posix_spawn_file_actions_addchdir(&' in spawn_text:
        spawn_source.write_text(spawn_text.replace('posix_spawn_file_actions_addchdir(&', 'posix_spawn_file_actions_addchdir_np(&'))
    task_header = source/'kernel/task.h'
    task_text = task_header.read_text()
    if 'nova_execution_id' not in task_text:
        task_header.write_text(task_text.replace('    uint64_t fs_context;', '    uint64_t fs_context;\n    // Nova execution ownership, inherited by tgroup_copy on fork.\n    uint64_t nova_execution_id;'))
    build = out/('build-'+args.sdk)
    sdk = subprocess.check_output(['xcrun','--sdk',args.sdk,'--show-sdk-path'],text=True).strip()
    cross = out/(args.sdk+'.ini')
    target = {'iphoneos':'arm64-apple-ios17.0','iphonesimulator':'arm64-apple-ios17.0-simulator','macosx':'arm64-apple-macos14.0'}[args.sdk]
    cross.write_text(f"[binaries]\nc = ['clang', '-target', '{target}', '-isysroot', '{sdk}']\nar = 'ar'\nstrip = 'strip'\npkg-config = 'false'\n[host_machine]\nsystem = 'darwin'\ncpu_family = 'aarch64'\ncpu = 'aarch64'\nendian = 'little'\n[properties]\nneeds_exe_wrapper = true\n")
    if not (build/'build.ninja').exists():
        run('meson','setup',str(build),str(source),'--cross-file',str(cross),'--buildtype=release','-Db_ndebug=true','-Dlog=','-Dlog_handler=nslog','-Dkernel=ish','-Dengine=asbestos','-Dguest_arch=arm64',env=env)
    run('ninja','-C',str(build),'libish.a','libish_emu.a','libfakefs.a',env=env)
    # Host converter is build-time only: iOS does not link desktop libarchive.
    native = out/'build-converter'
    if not (native/'build.ninja').exists():
        native_env = dict(env, PKG_CONFIG_PATH='/opt/homebrew/opt/libarchive/lib/pkgconfig')
        run('meson','setup',str(native),str(source),'--buildtype=release','-Dlog=','-Dguest_arch=arm64',env=native_env)
    run('ninja','-C',str(native),'tools/fakefsify',env=env)
    alpine = downloads/'alpine-minirootfs-3.21.0-aarch64.tar.gz'
    download('https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/'+alpine.name, alpine, ALPINE_SHA256)
    resources = out/'resources'; resources.mkdir(exist_ok=True)
    rootfs = resources/'NovaAlpine'
    if not rootfs.exists():
        staging = resources/('NovaAlpine.install-'+str(os.getpid()))
        run(str(native/'tools/fakefsify'),str(alpine),str(staging),env=env)
        staging.rename(rootfs)
    if not (rootfs/'meta.db').is_file() or not (rootfs/'data').is_dir():
        raise SystemExit('Incomplete existing fakefs root; preserve it for recovery before rebuilding')
    includes = out/'include'; includes.mkdir(exist_ok=True)
    if not (includes/'ish').exists(): (includes/'ish').symlink_to(source, target_is_directory=True)
    manifest = {'ish_commit':ISH_COMMIT,'ish_archive_sha256':ISH_SHA256,'alpine_archive_sha256':ALPINE_SHA256,'sdk':args.sdk,'patches':['darwin-spawn-chdir-np','nova-execution-ownership-v1']}
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(f'Runtime ready: {out} ({args.sdk})')
if __name__ == '__main__': main()
