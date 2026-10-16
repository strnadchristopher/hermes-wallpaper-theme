"""Wallpaper Theme backend — the palette-file reader behind ``desktop/plugin.js``.

Mounted at ``/api/plugins/wallpaper-theme/`` by the dashboard plugin system once the
plugin is in ``plugins.enabled``. The desktop half reaches it with ``ctx.rest('/palette')``;
nothing else is exposed.

``GET /palette?path=&since=``
    ``path``   palette file chosen in Settings. Blank falls through to ``"source"`` in
               ``~/.config/hermes-wallpaper-theme/config.json``, then Pywal's
               ``~/.cache/wal/colors.json``.
    ``since``  the ``stamp`` of the previous reply. While the file has not changed the
               route only stats it and answers ``{"ok": true, "unchanged": true}``.

Reads are deliberately narrow. The file must be a regular file under the user's home
(or an ``XDG_*_HOME`` directory), at most 256 KiB, and valid JSON; and the reply carries
only the colour fields of the two supported formats — never the file's raw text, never
keys the theme does not use. A failure is ``{"ok": false, "error": "..."}`` with a short
reason, no traceback, no contents.

Paths resolve on the machine running the Hermes backend (``hermes serve``), which is the
machine running Desktop for a local install.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Query

router = APIRouter()

PLUGIN_ID = "wallpaper-theme"
PYWAL_PATH = "~/.cache/wal/colors.json"
CONFIG_PATH = "~/.config/hermes-wallpaper-theme/config.json"
MAX_BYTES = 256 * 1024

_PYWAL_SPECIAL = ("background", "foreground")
_PYWAL_SLOTS = tuple(f"color{i}" for i in range(16))
_FLAT_KEYS = ("background", "foreground", "surface", "accent", "selection_text", "selectionText")
# Loose on purpose: the desktop half normalises; this only keeps the reply to colour-shaped strings.
_COLOR = re.compile(r"^#?[0-9a-fA-F]{3,8}$")


class PaletteError(ValueError):
    """A reason safe to show the user (never includes file contents)."""


# ─── Source resolution ─────────────────────────────────────────────────────────

def resolve_source(settings_path: Any, config: Any) -> tuple[str, str]:
    """Settings path > config file ``source`` > Pywal. Blank strings fall through.

    Returns ``(path, origin)`` with ``origin`` in ``settings`` / ``config`` / ``default``.
    """
    from_settings = settings_path.strip() if isinstance(settings_path, str) else ""
    if from_settings:
        return from_settings, "settings"
    from_config = ""
    if isinstance(config, dict) and isinstance(config.get("source"), str):
        from_config = config["source"].strip()
    if from_config:
        return from_config, "config"
    return PYWAL_PATH, "default"


def allowed_roots() -> list[Path]:
    """Where palette files may live: the home directory plus any XDG base dirs set in the env."""
    roots = [Path.home()]
    for var in ("XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
        value = os.environ.get(var, "")
        if value and os.path.isabs(value):
            roots.append(Path(value))
    return [Path(os.path.realpath(root)) for root in roots]


def resolve_path(raw: str) -> Path:
    """Expand ``~``, require an absolute path and confine it (after symlinks) to ``allowed_roots``."""
    text = raw.strip() if isinstance(raw, str) else ""
    if not text:
        raise PaletteError("no palette path")
    expanded = Path(os.path.expanduser(text))
    if not expanded.is_absolute():
        raise PaletteError("path must be absolute or start with ~")
    real = Path(os.path.realpath(expanded))
    if not any(real == root or root in real.parents for root in allowed_roots()):
        raise PaletteError("outside your home directory")
    return real


# ─── Reading ───────────────────────────────────────────────────────────────────

def file_stamp(real: Path) -> str:
    """A cheap change token: path digest + mtime + size. Raises PaletteError for anything unreadable."""
    try:
        st = os.stat(real)
    except FileNotFoundError:
        raise PaletteError("no such file") from None
    except PermissionError:
        raise PaletteError("permission denied") from None
    except OSError as exc:
        raise PaletteError(exc.strerror or type(exc).__name__) from None
    if not stat.S_ISREG(st.st_mode):
        raise PaletteError("not a regular file")
    if st.st_size > MAX_BYTES:
        raise PaletteError("larger than 256 KiB")
    digest = hashlib.sha1(str(real).encode("utf-8", "surrogateescape")).hexdigest()[:10]
    return f"{digest}:{st.st_mtime_ns}:{st.st_size}"


def read_json(real: Path) -> Any:
    """Parse the file as JSON; a half-written file is reported, never relayed."""
    try:
        with open(real, "rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
    except PermissionError:
        raise PaletteError("permission denied") from None
    except OSError as exc:
        raise PaletteError(exc.strerror or type(exc).__name__) from None
    if len(raw) > MAX_BYTES:
        raise PaletteError("larger than 256 KiB")
    try:
        return json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise PaletteError("not valid JSON") from None


def _color(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text if _COLOR.match(text) else None


def project_palette(data: Any) -> Optional[dict[str, Any]]:
    """Keep only the colour fields the theme reads; ``None`` when neither format is recognisable.

    Pywal: ``special.background/foreground`` + ``colors.color0..15``.
    Flat:  ``background``, ``foreground`` and the optional ``surface``/``accent``/``selection_text``.
    """
    if not isinstance(data, dict):
        return None
    special, colors = data.get("special"), data.get("colors")
    if isinstance(special, dict) and isinstance(colors, dict):
        kept_special = {k: c for k in _PYWAL_SPECIAL if (c := _color(special.get(k)))}
        kept_colors = {k: c for k in _PYWAL_SLOTS if (c := _color(colors.get(k)))}
        if len(kept_special) == 2:
            return {"special": kept_special, "colors": kept_colors}
        return None
    flat = {k: c for k in _FLAT_KEYS if (c := _color(data.get(k)))}
    if "background" in flat and "foreground" in flat:
        return flat
    return None


def read_config() -> Optional[dict[str, Any]]:
    """``~/.config/hermes-wallpaper-theme/config.json`` as a dict, or ``None`` when absent or unusable."""
    try:
        data = read_json(resolve_path(CONFIG_PATH))
    except PaletteError:
        return None
    return data if isinstance(data, dict) else None


# ─── Route ─────────────────────────────────────────────────────────────────────

def palette_reply(path: str = "", since: str = "") -> dict[str, Any]:
    """The whole request as a plain function so tests need no HTTP client."""
    source, origin = resolve_source(path, None if (path or "").strip() else read_config())
    reply: dict[str, Any] = {"path": source, "origin": origin}
    try:
        real = resolve_path(source)
        stamp = file_stamp(real)
        if since and since == stamp:
            return {"ok": True, "unchanged": True, "stamp": stamp, **reply}
        palette = project_palette(read_json(real))
    except PaletteError as exc:
        return {"ok": False, "error": str(exc), **reply}
    if palette is None:
        return {"ok": False, "error": "not a Pywal or flat palette JSON", **reply}
    return {"ok": True, "stamp": stamp, "palette": palette, **reply}


@router.get("/palette")
def palette(path: str = Query("", max_length=4096), since: str = Query("", max_length=128)) -> dict[str, Any]:
    """Resolve, read and project the palette file. Sync on purpose: a stat and a tiny read, off the event loop."""
    try:
        return palette_reply(path, since)
    except Exception as exc:  # plugin contract: never raise out of the handler
        return {"ok": False, "error": type(exc).__name__}
