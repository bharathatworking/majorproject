"""
Checks training/colab/train_clarity_lora.ipynb without a GPU:
nbformat.validate, then every code cell is compiled with py_compile.

  python training/colab/check_notebook.py

Colab shell lines (`!pip ...`) and magics (`%%capture`) are not Python, so
they become comments before compiling; the line numbers stay the same.
"""

import py_compile
import sys
import tempfile
from pathlib import Path

import nbformat

NOTEBOOK = Path(__file__).with_name('train_clarity_lora.ipynb')


def as_python(source):
    return '\n'.join('# ' + line if line.lstrip().startswith(('!', '%')) else line for line in source.split('\n'))


def main():
    nb = nbformat.read(str(NOTEBOOK), as_version=4)
    nbformat.validate(nb)
    print(f'[Clarity] {NOTEBOOK.name}: nbformat {nb.nbformat}.{nb.nbformat_minor} valid, {len(nb.cells)} cells')
    failures = 0
    code_cells = [c for c in nb.cells if c.cell_type == 'code']
    with tempfile.TemporaryDirectory() as tmp:
        for i, cell in enumerate(code_cells, 1):
            path = Path(tmp) / f'cell_{i:02d}.py'
            path.write_text(as_python(cell.source), encoding='utf-8')
            try:
                py_compile.compile(str(path), doraise=True)
            except py_compile.PyCompileError as err:
                failures += 1
                print(f'[Clarity] code cell {i} does not compile:\n{err.msg}')
    print(f'[Clarity] {len(code_cells) - failures}/{len(code_cells)} code cells compile')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
