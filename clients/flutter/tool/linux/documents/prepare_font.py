#!/usr/bin/env python3
"""Build-only fontTools entry point: static, renamed OFL derivative for review."""
import argparse
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('charset', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    font = TTFont(args.source, recalcTimestamp=False)
    font = instantiateVariableFont(font, {'wght': 400}, inplace=True)
    options = subset.Options()
    options.recalc_timestamp = False
    options.canonical_order = True
    options.name_IDs = ['*']
    options.name_legacy = True
    options.name_languages = ['*']
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=args.charset.read_text().rstrip('\n'))
    subsetter.subset(font)
    names = {1: 'Nova Document Sans SC', 2: 'Regular',
             3: 'NovaDocumentSansSC-Regular-2.004-subset1',
             4: 'Nova Document Sans SC Regular', 6: 'NovaDocumentSansSC-Regular',
             16: 'Nova Document Sans SC', 17: 'Regular',
             18: 'Nova Document Sans SC Regular', 21: 'Nova Document Sans SC', 22: 'Regular'}
    for record in font['name'].names:
        if record.nameID in names:
            record.string = names[record.nameID].encode(record.getEncoding())
    for name_id, value in names.items():
        font['name'].setName(value, name_id, 3, 1, 0x409)
    assert 'fvar' not in font and 'gvar' not in font
    font.save(args.output, reorderTables=True)


if __name__ == '__main__':
    main()
