#!/usr/bin/env python3
"""Render Git-tracked working-tree code counts. Requires Python 3 + matplotlib."""
import argparse
from collections import defaultdict
import json
import os
from pathlib import Path
import subprocess
import tempfile

EXTENSIONS = set('.ts .tsx .js .jsx .mjs .cjs .py .swift .c .h .cc .cpp .hpp .m .mm .rs .go .java .kt .kts .sh .ps1 .sql .css .scss .html .vue .svelte .proto'.split())
COLORS = {'production': '#4c78a8', 'tests': '#f2a541', 'tooling': '#8c6bb1', 'evaluation': '#46a998'}


def category(path):
    parts = path.parts
    if any(p in {'test', 'tests', '__tests__', 'fixtures'} for p in parts) or any(s in path.name for s in ('.test.', '.spec.')):
        return 'tests'
    if any(p in {'eval', 'evaluation', 'evaluations', 'benchmarks'} for p in parts):
        return 'evaluation'
    if any(p in {'scripts', 'tools', '.github'} for p in parts):
        return 'tooling'
    return 'production'


def collect(repo, scope, depth, metric, large_ts=1000):
    names = subprocess.check_output(['git', '-C', str(repo), 'ls-files', '-z']).split(b'\0')
    rows = defaultdict(lambda: dict.fromkeys(COLORS, 0))
    files = []
    skipped = []
    for raw in sorted(set(names) - {b''}):
        path = Path(os.fsdecode(raw))
        if path.suffix.lower() not in EXTENSIONS:
            continue
        try:
            relative = path.relative_to(scope)
        except ValueError:
            continue
        full = repo / path
        if full.is_symlink() or not full.is_file():
            skipped.append(path.as_posix())
            continue
        data = full.read_bytes()
        try:
            if b'\0' in data:
                raise UnicodeError('binary')
            lines = data.decode('utf-8-sig').splitlines()
        except UnicodeError:
            skipped.append(path.as_posix())
            continue
        count = len(lines) if metric == 'physical' else sum(bool(line.strip()) for line in lines)
        module = Path(*relative.parent.parts[:depth]).as_posix()
        if module == '.':
            module = '(root module)'
        if large_ts and path.suffix.lower() in {'.ts', '.tsx'} and count >= large_ts:
            module = relative.as_posix() + ' [large TS]'
        kind = category(path)
        rows[module][kind] += count
        files.append({'path': path.as_posix(), 'module': module, 'category': kind, 'lines': count})
    return dict(sorted(rows.items(), key=lambda item: (-sum(item[1].values()), item[0]))), files, skipped


def render(report, output, top):
    os.environ.setdefault('MPLCONFIGDIR', str(Path(tempfile.gettempdir()) / 'nova-code-map-mpl'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    rows = list(report['modules'].items())
    if len(rows) > top:
        rest = {key: sum(values[key] for _, values in rows[top:]) for key in COLORS}
        rows = rows[:top] + [('Other modules (combined)', rest)]
    rows = [(name, counts) for name, counts in rows if sum(counts.values()) > 0]
    fig, ax = plt.subplots(figsize=(16, max(7, len(rows) * .28 + 2)), layout='constrained')
    fig.set_facecolor('#fafbfc')
    values = [sum(counts.values()) for _, counts in rows]
    if values:
        colors = [plt.get_cmap('tab20')(i % 20) for i in range(len(rows))]
        wedges, _, _ = ax.pie(values, startangle=90, counterclock=False, colors=colors,
                             autopct=lambda percent: f'{percent:.1f}%' if percent >= 3 else '',
                             pctdistance=.76, wedgeprops={'edgecolor': 'white', 'linewidth': 1})
        labels = [f'{name}  —  {value:,} ({value / report["total"]:.1%})'
                  for (name, _), value in zip(rows, values)]
        ax.legend(wedges, labels, loc='center left', bbox_to_anchor=(1, .5), frameon=False, fontsize=9)
    else:
        ax.text(.5, .5, 'No nonzero lines', ha='center', transform=ax.transAxes)
    ax.set_title(f"{Path(report['repo']).name} / {report['scope']}  |  {report['total']:,} lines\n"
                 f"{report['metric']} lines · comments included · depth {report['depth']}\n"
                 f"Large TS threshold: {report['large_ts'] or 'disabled'} · extracted files counted once",
                 loc='left', pad=20)
    fig.savefig(output, dpi=180)
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd(), help='repository or worktree (default: cwd)')
    parser.add_argument('--scope', default='.', help='subdirectory relative to repository root')
    parser.add_argument('--depth', type=int, default=3, help='grouping depth relative to scope (default: 3)')
    parser.add_argument('--top', type=int, default=15, help='largest modules to display; remainder is combined')
    parser.add_argument('--large-ts', type=int, default=1000, help='separate TS/TSX files at this many lines; 0 disables')
    parser.add_argument('--metric', choices=['nonblank', 'physical'], default='nonblank')
    parser.add_argument('--output', type=Path, default=Path('dist/code-map.png'))
    args = parser.parse_args()
    if args.depth < 1 or args.top < 1 or args.large_ts < 0:
        parser.error('--depth and --top must be positive; --large-ts must be nonnegative')
    repo = Path(subprocess.check_output(['git', '-C', str(args.repo), 'rev-parse', '--show-toplevel'], text=True).strip())
    try:
        scope = (repo / args.scope).resolve().relative_to(repo.resolve())
    except ValueError:
        parser.error('--scope must stay inside the repository')
    rows, files, skipped = collect(repo, scope, args.depth, args.metric, args.large_ts)
    if not files:
        parser.error('no supported tracked code files in this scope')
    report = dict(repo=str(repo), scope=scope.as_posix(), depth=args.depth, metric=args.metric, large_ts=args.large_ts,
                  total=sum(f['lines'] for f in files), modules=rows, files=files, skipped=skipped)
    output = args.output.resolve()
    if output.suffix.lower() != '.png':
        parser.error('--output must end in .png')
    output.parent.mkdir(parents=True, exist_ok=True)
    render(report, output, args.top)
    output.with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(f"{report['total']:,} lines / {len(files):,} files / {len(rows)} modules; {len(skipped)} skipped\n{output}\n{output.with_suffix('.json')}")


if __name__ == '__main__':
    main()
