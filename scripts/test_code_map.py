"""Run: python3 scripts/test_code_map.py"""
import importlib.util
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('code_map', Path(__file__).with_name('code-map.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    subprocess.run(['git', 'init', '-q', directory], check=True)
    for name, content in {
        'src/core/a.ts': 'const a = 1;\n\n// comment\n',
        'src/core/b.ts': 'last line',
        'tests/a.test.ts': 'assert(true)\n',
        'scripts/run.py': 'print(1)\n',
        'evaluation/run.ts': 'run()\n',
        'README.md': 'not code\n',
    }.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    (root / 'src/core/link.ts').symlink_to(root / 'src/core/a.ts')
    subprocess.run(['git', '-C', directory, 'add', '.'], check=True)
    (root / 'untracked.ts').write_text('excluded\n')
    rows, files, skipped = module.collect(root, Path('.'), 2, 'nonblank')
    assert rows['src/core']['production'] == 3
    assert sum(f['lines'] for f in files) == 6
    assert rows['tests']['tests'] == 1
    assert rows['scripts']['tooling'] == 1
    assert rows['evaluation']['evaluation'] == 1
    assert skipped == ['src/core/link.ts']
    rows, files, _ = module.collect(root, Path('src'), 1, 'physical')
    assert rows['core']['production'] == 4
    assert len(files) == 2
    rows, files, _ = module.collect(root, Path('src/core'), 3, 'nonblank', large_ts=2)
    assert rows['a.ts [large TS]']['production'] == 2
    assert rows['(root module)']['production'] == 1
    assert sum(sum(row.values()) for row in rows.values()) == 3
    rows, _, _ = module.collect(root, Path('src/core'), 3, 'nonblank', large_ts=0)
    assert list(rows) == ['(root module)']
    assert rows['(root module)']['production'] == 3
print('PASS: grouping, scope, categories, blank lines, final line, untracked and symlink exclusion')
