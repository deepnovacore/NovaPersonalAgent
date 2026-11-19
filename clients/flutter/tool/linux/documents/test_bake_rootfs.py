#!/usr/bin/env python3
"""Host-only regression tests; never downloads or starts Docker."""
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import bake_rootfs


class BakeRootfsTest(unittest.TestCase):
    def test_output_requires_absolute_internal_non_root_directory(self):
        for path in ['relative', '/', '/Volumes/external/build']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                bake_rootfs.validate_output(Path(path))

    def test_ci_output_requires_runner_namespace(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_TEMP': '/tmp/runner'}):
            self.assertEqual(bake_rootfs.validate_output(Path('/tmp/runner/chat'), ci_runner_temp=True),
                             Path('/tmp/runner/chat').resolve())
            for path in ['/tmp/runner', '/tmp/other']:
                with self.assertRaises(ValueError):
                    bake_rootfs.validate_output(Path(path), ci_runner_temp=True)

    def test_missing_docker_fails_with_actionable_message(self):
        with patch('bake_rootfs.subprocess.run', side_effect=FileNotFoundError):
            with self.assertRaisesRegex(ValueError, 'Docker CLI not found'):
                bake_rootfs.require_container('missing-docker', 'alpine@sha256:locked')

    def test_missing_image_reports_exact_digest_pull(self):
        import subprocess
        with patch('bake_rootfs.subprocess.run', side_effect=[
                subprocess.CompletedProcess([], 0, '29.2.0', ''),
                subprocess.CompletedProcess([], 1, '', 'missing')]):
            with self.assertRaisesRegex(ValueError, 'pull --platform linux/arm64 alpine@sha256:locked'):
                bake_rootfs.require_container('docker', 'alpine@sha256:locked')

    def test_cached_download_is_always_reverified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'input').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError, 'Integrity mismatch'):
                bake_rootfs.download({'filename': 'input', 'sha256': '0' * 64}, root)

    def test_canonicalize_normalizes_order_times_and_gzip_header(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = []
            manifests = []
            for number, order in enumerate([['b', 'a'], ['a', 'b']]):
                source = root / f'{number}.tar'
                with tarfile.open(source, 'w') as archive:
                    for name in order:
                        member = tarfile.TarInfo(name)
                        member.size = 1
                        member.mtime = 1000 + number
                        member.mode = 0o750
                        member.uid = 7
                        member.uname = f'ignored-{number}'
                        archive.addfile(member, io.BytesIO(name.encode()))
                output = root / f'{number}.tgz'
                manifests.append(bake_rootfs.canonicalize(source, output))
                outputs.append(output.read_bytes())
            self.assertEqual(outputs[0], outputs[1])
            self.assertEqual(manifests[0], manifests[1])
            with tarfile.open(root / '0.tgz') as archive:
                self.assertEqual(archive.getmember('a').uid, 7)
                self.assertEqual(archive.getmember('a').mode, 0o750)
                self.assertEqual(archive.getmember('a').mtime, 0)

    def test_locks_pin_complete_validated_wheel_set_and_apks(self):
        wheels = bake_rootfs.load_lock('wheels')['wheels']
        self.assertEqual({item['name'] for item in wheels if not item['build_only']},
                         {'openpyxl', 'et_xmlfile', 'pypdf', 'reportlab', 'pillow', 'charset-normalizer',
                          'python-docx', 'lxml', 'typing_extensions'})
        for platform in ['ios', 'android']:
            lock = bake_rootfs.load_lock(platform)
            self.assertIn('@sha256:', lock['container'])
            self.assertEqual(len(lock['apks']), 29)
            self.assertEqual(lock['apk_roots'], ['python3', 'py3-pip'])
            self.assertEqual(next(item['version'] for item in lock['apks'] if item['name'] == 'python3'), '3.12.16-r0')
            for item in lock['apks'] + wheels + [lock['base']]:
                self.assertRegex(item['sha256'], r'^[0-9a-f]{64}$')
                self.assertTrue(item['url'].startswith('https://'))
            for item in lock['apks']:
                self.assertTrue(item['apkindex_checksum'].startswith('Q1'))

    def test_bake_records_hook_and_runs_naive_smoke_in_target_rootfs(self):
        import inspect
        import smoke
        source = inspect.getsource(bake_rootfs.bake)
        self.assertIn("'sitecustomize_sha256': sha256(HERE / 'nova_sitecustomize.py')", source)
        self.assertIn('Refusing to overwrite sitecustomize', source)
        self.assertIn('sysconfig.get_path("purelib")', source)
        self.assertIn('chroot /build/root', source)
        self.assertIn("'Helvetica-Bold'", smoke.NAIVE_SCRIPT)
        self.assertEqual(len(smoke.FIRST_IMPORTS), 3)
        processes = [__import__('subprocess').CompletedProcess([], 0, '{"passed": true}', '')] * 3
        with patch('smoke.subprocess.run', side_effect=processes) as run:
            self.assertTrue(all(result['passed'] for result in smoke.default_font_smoke()))
        self.assertEqual(run.call_count, 3)
        for call, first in zip(run.call_args_list, smoke.FIRST_IMPORTS):
            self.assertTrue(call.args[0][-1].startswith(first + '\n'))

    def test_font_charset_matches_approved_input(self):
        lock = bake_rootfs.load_lock('font')
        actual = hashlib.sha256((bake_rootfs.HERE / 'font-charset.txt').read_bytes()).hexdigest()
        self.assertEqual(actual, lock['charset_sha256'])
        self.assertTrue(lock['publication_approved'])
        chars = (bake_rootfs.HERE / 'font-charset.txt').read_text()
        for char in '中文汇总：总和 1001000':
            self.assertIn(char, chars)
        self.assertEqual(chars.rstrip('\n'), ''.join(sorted(set(chars.rstrip('\n')))))


if __name__ == '__main__':
    unittest.main()
