"""Load the plugin modules and mutagen without Picard.

Used by the tests and by scripts/scan_folder.py.

The plugin's __init__.py and src/plugin.py need a running Picard, so callers
register the repo folder as a package without executing it. The modules in src/
use relative imports and load normally inside that package.

mutagen is not installed in the development Python, but Picard bundles it.
load_mutagen() imports it from the installed Picard's PyInstaller archive, when
that archive was built for the same Python version as the running one.
"""

from __future__ import annotations

import importlib.abc
import importlib.util
import marshal
import os
import struct
import sys
import types
import zlib


PACKAGE = 'shironet_lyrics'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_PICARD_EXE = r'C:\Program Files\MusicBrainz Picard\picard.exe'

_COOKIE_MAGIC = b'MEI\014\013\012\013\016'
_COOKIE_FORMAT = '!8sIIII64s'
_TOC_ENTRY_FORMAT = '!IIIIBc'
_PYZ_PACKAGE = 1


def load_plugin_package() -> str:
    if PACKAGE not in sys.modules:
        package = types.ModuleType(PACKAGE)
        package.__path__ = [ROOT]
        sys.modules[PACKAGE] = package
    return PACKAGE


def default_db_path() -> str:
    """The plugin's cache file: Qt's AppDataLocation for MusicBrainz/Picard."""
    if sys.platform == 'win32':
        base = os.environ.get('APPDATA') or os.path.join(os.path.expanduser('~'), 'AppData', 'Roaming')
    elif sys.platform == 'darwin':
        base = os.path.expanduser('~/Library/Application Support')
    else:
        base = os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share')
    return os.path.join(base, 'MusicBrainz', 'Picard', 'plugin-data', 'shironet-lyrics', 'lyrics.sqlite3')


def load_mutagen(picard_exe: str | None = None) -> bool:
    """Make `import mutagen` work. Returns False when no mutagen is found.

    Uses an installed mutagen first, then the one inside `picard_exe` (default:
    the PICARD_EXE environment variable, then DEFAULT_PICARD_EXE).
    """
    try:
        import mutagen  # noqa: F401
        return True
    except ImportError:
        pass
    exe = picard_exe or os.environ.get('PICARD_EXE', DEFAULT_PICARD_EXE)
    try:
        finder = _PyzFinder.from_exe(exe, prefix='mutagen')
    except (OSError, ValueError):
        return False
    if finder is None:
        return False
    sys.meta_path.append(finder)
    try:
        import mutagen  # noqa: F401
    except Exception:
        sys.meta_path.remove(finder)
        return False
    return True


class _PyzFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Imports modules from the PYZ archive inside a PyInstaller executable.

    It runs marshal.loads() on the archive's bytecode. That is safe only because the
    archive is the locally installed Picard, whose code already runs as that program.
    Never point PICARD_EXE at an executable you would not run.
    """

    def __init__(self, pyz: bytes, toc: dict, prefix: str):
        self._pyz = pyz
        self._toc = toc
        self._prefix = prefix

    @classmethod
    def from_exe(cls, exe: str, prefix: str) -> _PyzFinder | None:
        with open(exe, 'rb') as f:
            data = f.read()
        cookie = data.rfind(_COOKIE_MAGIC)
        if cookie < 0:
            raise ValueError('not a PyInstaller executable')
        _, package_length, toc_offset, toc_length, _, _ = struct.unpack(
            _COOKIE_FORMAT, data[cookie:cookie + struct.calcsize(_COOKIE_FORMAT)]
        )
        start = cookie + struct.calcsize(_COOKIE_FORMAT) - package_length
        toc = data[start + toc_offset:start + toc_offset + toc_length]
        position = 0
        while position < len(toc):
            entry_length, offset, length, _, _, typecode = struct.unpack(
                _TOC_ENTRY_FORMAT, toc[position:position + struct.calcsize(_TOC_ENTRY_FORMAT)]
            )
            position += entry_length
            if typecode == b'z':
                pyz = data[start + offset:start + offset + length]
                break
        else:
            raise ValueError('no PYZ archive found')

        if pyz[:4] != b'PYZ\0':
            raise ValueError('bad PYZ header')
        if pyz[4:8] != importlib.util.MAGIC_NUMBER:
            return None  # bytecode for another Python version
        (toc_position,) = struct.unpack('!i', pyz[8:12])
        return cls(pyz, dict(marshal.loads(pyz[toc_position:])), prefix)

    def find_spec(self, fullname, path=None, target=None):
        if fullname != self._prefix and not fullname.startswith(self._prefix + '.'):
            return None
        entry = self._toc.get(fullname)
        if entry is None:
            return None
        is_package = entry[0] == _PYZ_PACKAGE
        spec = importlib.util.spec_from_loader(fullname, self, is_package=is_package)
        if is_package:
            spec.submodule_search_locations = []
        return spec

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        _, offset, length = self._toc[module.__name__]
        code = marshal.loads(zlib.decompress(self._pyz[offset:offset + length]))
        exec(code, module.__dict__)
