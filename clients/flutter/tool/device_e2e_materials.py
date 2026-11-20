#!/usr/bin/env python3
"""Embed only the authorized synthetic/public inputs in an ignored fixture file."""
import argparse
import base64
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--materials', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
entrypoint = args.output.with_name('device_e2e_acceptance.dart')
if args.output == entrypoint:
    parser.error('--output must name the materials file, not the generated entrypoint')
inputs = {name: base64.b64encode((args.materials / name).read_bytes()).decode('ascii')
          for name in ('sales-oct.xlsx', '2603.02206v1.pdf', '2410.08328v1.pdf')}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text('// Generated acceptance inputs; do not commit.\n'
                       'const deviceE2eMaterials = <String, String>'
                       + json.dumps(inputs) + ';\n')

# Keep the existing Flutter target path for manual device runs.
entrypoint.write_text('// Generated real-device acceptance target.\n'
                      "import 'device_e2e_runner.dart';\n"
                      f'import {json.dumps(args.output.name)};\n\n'
                      'Future<void> main() => runDeviceAcceptance(deviceE2eMaterials);\n')
