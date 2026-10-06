"""Test helpers. The loaders live in scripts/_bootstrap.py, shared with the scripts."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))

from _bootstrap import load_mutagen, load_plugin_package  # noqa: E402

__all__ = ['load_mutagen', 'load_plugin_package']
