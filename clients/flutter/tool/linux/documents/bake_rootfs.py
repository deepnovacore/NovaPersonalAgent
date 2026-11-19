#!/usr/bin/env python3
"""Bake locked ARM64 document packages in an offline, digest-pinned container."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
FONT_PATH = '/usr/share/fonts/nova/NovaDocumentSansSC-Regular.ttf'


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_lock(name):
    return json.loads((HERE / 'locks' / (name + '.json')).read_text())


def validate_output(path, ci_runner_temp=False):
    resolved = path.resolve()
    if not path.is_absolute() or resolved == Path(resolved.anchor) or resolved.is_relative_to('/Volumes'):
        raise ValueError('output must be an explicit isolated absolute directory on internal storage')
    if ci_runner_temp:
        temporary = os.environ.get('RUNNER_TEMP')
        if os.environ.get('GITHUB_ACTIONS') != 'true' or not temporary or resolved == Path(temporary).resolve() or not resolved.is_relative_to(Path(temporary).resolve()):
            raise ValueError('CI output must be strictly below GitHub Actions RUNNER_TEMP')
    return resolved


def verified_ios_archive(directory):
    archive = directory / 'rootfs.tgz'
    manifest = json.loads((directory / 'manifest.json').read_text())
    expected = {
        'platform': 'ios', 'lock_sha256': sha256(HERE / 'locks/ios.json'),
        'wheels_lock_sha256': sha256(HERE / 'locks/wheels.json'),
        'font': {**load_lock('font'), 'bundled': True},
        'sitecustomize_sha256': sha256(HERE / 'nova_sitecustomize.py'),
        'archive_sha256': sha256(archive),
    }
    if any(manifest.get(key) != value for key, value in expected.items()) or manifest['smoke']['passed'] is not True:
        raise ValueError('Baked iOS document archive or manifest does not match the verified inputs')
    return archive


def download(item, directory):
    target = directory / item['filename']
    if not target.exists():
        temporary = target.with_suffix(target.suffix + '.download')
        try:
            with urllib.request.urlopen(item['url'], timeout=120) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output)
            if sha256(temporary) != item['sha256']:
                raise ValueError('Integrity mismatch: ' + target.name)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    if sha256(target) != item['sha256']:
        raise ValueError('Integrity mismatch: ' + target.name)
    return target


def canonicalize(source, destination):
    """Preserve POSIX owners/modes/links; normalize tar/gzip times and order."""
    records = []
    with tarfile.open(source) as original, destination.open('wb') as raw:
        members = sorted(original.getmembers(), key=lambda member: member.name)
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.GNU_FORMAT) as archive:
                for member in members:
                    member.mtime = 0
                    member.uname = member.gname = ''
                    member.pax_headers = {}
                    stream = original.extractfile(member) if member.isfile() else None
                    record = {'path': member.name, 'type': member.type.decode('ascii'),
                              'mode': member.mode, 'uid': member.uid, 'gid': member.gid,
                              'link': member.linkname, 'size': member.size}
                    if stream is not None:
                        data = stream.read()
                        record['sha256'] = hashlib.sha256(data).hexdigest()
                        stream = io.BytesIO(data)
                    records.append(record)
                    archive.addfile(member, stream)
    return records


def require_container(docker, image):
    try:
        daemon = subprocess.run([docker, 'info', '--format', '{{.ServerVersion}}'],
                                capture_output=True, text=True)
    except FileNotFoundError as error:
        raise ValueError('Docker CLI not found. Install Docker, start its daemon on internal storage, '
                         'and pass --docker /absolute/path/to/docker; see documents/README.md') from error
    if daemon.returncode:
        raise ValueError('Docker daemon unavailable. Start Docker on internal storage or use an ARM64 '
                         'Linux Docker host; no bare-rootfs fallback is allowed. ' + daemon.stderr.strip())
    image_check = subprocess.run([docker, 'image', 'inspect', image], capture_output=True, text=True)
    if image_check.returncode:
        raise ValueError(f'Missing pinned image. Run: {docker} pull --platform linux/arm64 {image}')


def bake(platform, output, *, docker='docker', without_font=False,
         verify_reproducible=False, ci_runner_temp=False):
    output = validate_output(Path(output), ci_runner_temp)
    output.mkdir(parents=True, exist_ok=True)
    lock = load_lock(platform)
    wheels = load_lock('wheels')['wheels']
    font = load_lock('font')
    require_container(docker, lock['container'])
    if sha256(HERE / 'font-charset.txt') != font['charset_sha256']:
        raise ValueError('Font character set integrity mismatch')
    inputs = output / 'inputs'
    inputs.mkdir(exist_ok=True)
    for subdir in ['apk', 'wheels', 'font']:
        (inputs / subdir).mkdir(exist_ok=True)
    base = download(lock['base'], inputs)
    for item in lock['apks']:
        download(item, inputs / 'apk')
    for item in wheels:
        download(item, inputs / 'wheels')
    for key in ['source', 'license']:
        download(font[key], inputs / 'font')
    runtime_wheels = [item for item in wheels if not item['build_only']]
    (inputs / 'requirements.txt').write_text(''.join(
        f"{item['name']}=={item['version']} --hash=sha256:{item['sha256']}\n" for item in runtime_wheels))
    expected_index = sorted(f"{item['name']} {item['version']} {item['apkindex_checksum']}" for item in lock['apks'])
    (inputs / 'expected-index.txt').write_text('\n'.join(expected_index) + '\n')
    shutil.copyfile(HERE / 'smoke.py', inputs / 'smoke.py')
    shutil.copyfile(HERE / 'nova_sitecustomize.py', inputs / 'sitecustomize.py')
    shutil.copyfile(HERE / 'prepare_font.py', inputs / 'prepare_font.py')
    shutil.copyfile(HERE / 'font-charset.txt', inputs / 'font-charset.txt')
    marker = {'schema': 1, 'platform': platform, 'font': {**font, 'bundled': not without_font},
              'lock_sha256': sha256(HERE / 'locks' / (platform + '.json')),
              'wheels_lock_sha256': sha256(HERE / 'locks/wheels.json'),
              'font_path': FONT_PATH if not without_font else None,
              'sitecustomize_sha256': sha256(HERE / 'nova_sitecustomize.py')}
    (inputs / 'document-base.json').write_text(json.dumps(marker, sort_keys=True) + '\n')
    fonttools = next(item['filename'] for item in wheels if item['name'] == 'fonttools')
    # All network access ends here. The container may only see verified inputs.
    script = r'''set -eu
export LC_ALL=C PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1 SOURCE_DATE_EPOCH=0
mkdir -p /build/root
tar -xzf /inputs/BASE -C /build/root
apk --keys-dir /build/root/etc/apk/keys verify /inputs/apk/*.apk
apk index --no-warnings -o /build/index.tar.gz /inputs/apk/*.apk
tar -xOzf /build/index.tar.gz APKINDEX | awk -F: '
$1=="P" {p=$2} $1=="V" {v=$2} $1=="C" {c=$2}
/^$/ {if(p!="") print p " " v " " c; p=""}
END {if(p!="") print p " " v " " c}' | sort > /build/index.txt
diff -u /inputs/expected-index.txt /build/index.txt
apk --root /build/root --no-network --repositories-file /dev/null add /inputs/apk/*.apk
mkdir -p /build/root/tmp/nova-input
cp /inputs/wheels/* /build/root/tmp/nova-input/
cp /inputs/requirements.txt /build/root/tmp/nova-input/
chroot /build/root /usr/bin/env PYTHONDONTWRITEBYTECODE=1 python3 -m pip install \
 --break-system-packages --no-index --find-links=/tmp/nova-input \
 --require-hashes --only-binary=:all: --no-deps --no-compile -r /tmp/nova-input/requirements.txt
# Query the installed Alpine interpreter, not a host/assumed site-packages path.
chroot /build/root python3 -c 'import importlib.util; assert importlib.util.find_spec("sitecustomize") is None, "Refusing to overwrite sitecustomize"'
site_packages=$(chroot /build/root python3 -c 'import sysconfig,sys; p=sysconfig.get_path("purelib"); assert p in sys.path; print(p)')
test ! -e "/build/root$site_packages/sitecustomize.py"
cp /inputs/sitecustomize.py "/build/root$site_packages/sitecustomize.py"
printf '%s\n' "$site_packages" > /out/site-packages.txt
cp /inputs/prepare_font.py /inputs/font-charset.txt /inputs/font/* /build/root/tmp/nova-input/
chroot /build/root /usr/bin/env PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/tmp/nova-input/FONTTOOLS \
 python3 /tmp/nova-input/prepare_font.py /tmp/nova-input/NotoSansSC-variable.ttf \
 /tmp/nova-input/font-charset.txt /tmp/nova-input/NovaDocumentSansSC-Regular.ttf
cp /build/root/tmp/nova-input/NovaDocumentSansSC-Regular.ttf /out/font.ttf
if [ "BUNDLE_FONT" = 1 ]; then
 mkdir -p /build/root/usr/share/fonts/nova /build/root/usr/share/licenses/nova-document-font
 cp /out/font.ttf /build/root/usr/share/fonts/nova/NovaDocumentSansSC-Regular.ttf
 cp /inputs/font/OFL.txt /build/root/usr/share/fonts/nova/OFL.txt
 cp /inputs/font/OFL.txt /build/root/usr/share/licenses/nova-document-font/OFL.txt
 smoke_font=/usr/share/fonts/nova/NovaDocumentSansSC-Regular.ttf
else
 smoke_font=/tmp/nova-input/NovaDocumentSansSC-Regular.ttf
fi
cp /inputs/smoke.py /build/root/tmp/nova-input/
chroot /build/root /usr/bin/env PYTHONDONTWRITEBYTECODE=1 python3 /tmp/nova-input/smoke.py \
 --font "$smoke_font" NAIVE_FLAG > /out/smoke.json
chroot /build/root /usr/bin/env PYTHONDONTWRITEBYTECODE=1 python3 -m pip check > /out/pip-check.txt
chroot /build/root /usr/bin/env PYTHONDONTWRITEBYTECODE=1 python3 -m pip list --format=json > /out/python-packages.json
apk --root /build/root info -v | sort > /out/apk-packages.txt
mkdir -p /build/root/usr/share/nova
cp /inputs/document-base.json /build/root/usr/share/nova/document-base.json
cp /inputs/smoke.py /build/root/usr/share/nova/document-smoke.py
rm -rf /build/root/tmp/nova-input /build/root/var/cache/apk/*
find /build/root -type d -name __pycache__ -exec rm -rf {} +
find /build/root -type f -name '*.pyc' -delete
# APK triggers create an empty random-named temporary cache directory.
rm -rf /build/root/tmp/*
tar -cf /out/rootfs.raw.tar -C /build/root .
'''.replace('NAIVE_FLAG', '--skip-default-font' if without_font else '').replace('BASE', base.name).replace('FONTTOOLS', fonttools).replace('BUNDLE_FONT', '0' if without_font else '1')
    manifests = []
    for number in range(2 if verify_reproducible else 1):
        attempt = output / f'attempt-{number + 1}'
        attempt.mkdir(exist_ok=True)
        subprocess.run([docker, 'run', '--rm', '--platform', 'linux/arm64', '--network=none',
                        '--mount', f'type=bind,source={inputs},target=/inputs,readonly',
                        '--mount', f'type=bind,source={attempt},target=/out',
                        lock['container'], '/bin/sh', '-ec', script], check=True)
        actual_font = sha256(attempt / 'font.ttf')
        if actual_font != font['subset_sha256']:
            raise ValueError(f'Font derivative mismatch: {actual_font}')
        records = canonicalize(attempt / 'rootfs.raw.tar', attempt / 'rootfs.tgz')
        (attempt / 'rootfs.raw.tar').unlink()
        (attempt / 'files.json').write_text(json.dumps(records, sort_keys=True, separators=(',', ':')) + '\n')
        manifests.append({'files_sha256': sha256(attempt / 'files.json'),
                          'archive_sha256': sha256(attempt / 'rootfs.tgz'),
                          'apk_packages_sha256': sha256(attempt / 'apk-packages.txt'),
                          'python_packages_sha256': sha256(attempt / 'python-packages.json')})
    if any(item != manifests[0] for item in manifests):
        raise ValueError('Independent rootfs builds differ; inspect attempt directories')
    filename = 'rootfs-without-font.tgz' if without_font else 'rootfs.tgz'
    shutil.copyfile(output / 'attempt-1/rootfs.tgz', output / filename)
    manifest = {**marker, **manifests[0], 'container': lock['container'],
                'base_bytes': base.stat().st_size, 'baked_bytes': (output / filename).stat().st_size,
                'font_bytes': (output / 'attempt-1/font.ttf').stat().st_size,
                'font_sha256': font['subset_sha256'], 'reproducible_builds': len(manifests),
                'smoke': json.loads((output / 'attempt-1/smoke.json').read_text())}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return output / filename


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=['ios', 'android'], required=True)
    parser.add_argument('--output-root', type=Path, required=True)
    parser.add_argument('--docker', default='docker')
    parser.add_argument('--without-font', action='store_true', help='Size comparison only; CJK smoke uses a temporary font')
    parser.add_argument('--verify-reproducible', action='store_true')
    parser.add_argument('--ci-runner-temp', action='store_true')
    args = parser.parse_args()
    try:
        bake(args.platform, args.output_root, docker=args.docker,
             without_font=args.without_font,
             verify_reproducible=args.verify_reproducible, ci_runner_temp=args.ci_runner_temp)
    except ValueError as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
