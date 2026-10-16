"""Tests for dashboard/plugin_api.py — the palette-file reader.

Run with ``python -m unittest discover tests`` (or ``pytest tests``). Needs ``fastapi``,
which every Hermes environment has.
"""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
API_FILE = ROOT / "dashboard" / "plugin_api.py"


def _load_api():
    if importlib.util.find_spec("fastapi") is None:
        raise unittest.SkipTest("fastapi not importable here; run with the Hermes venv's python")
    spec = importlib.util.spec_from_file_location("wallpaper_theme_api", API_FILE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = _load_api()


PYWAL = {
    "wallpaper": "/tmp/wall.jpg",
    "special": {"background": "#0f1417", "foreground": "#c3c5c7", "cursor": "#c3c5c7"},
    "colors": {f"color{i}": c for i, c in enumerate(
        ["#0f1417", "#3b4a52", "#56707a", "#a0603a", "#6f8a5c", "#7d6aa0", "#5d8fa3", "#c3c5c7",
         "#888a8b", "#3b4a52", "#56707a", "#a0603a", "#6f8a5c", "#7d6aa0", "#5d8fa3", "#c3c5c7"])},
}
FLAT = {
    "background": "#151817", "surface": "#252927", "foreground": "#f5f6f8", "accent": "#b4c3be",
    "selection_text": "#06090a", "selection_contrast": 10.93, "worst_case_body_contrast": 9.43,
    "wallpaper": "/home/me/Pictures/secret-name.png",
}


class FakeHome(unittest.TestCase):
    """Every test runs against a throwaway HOME so nothing touches the real ~/.cache/wal."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(os.path.realpath(self._tmp.name)) / "home"
        self.home.mkdir()
        self.outside = Path(os.path.realpath(self._tmp.name)) / "outside"
        self.outside.mkdir()
        self._env = mock.patch.dict(os.environ, {"HOME": str(self.home)}, clear=False)
        self._env.start()
        for var in ("XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
            os.environ.pop(var, None)
        self._home = mock.patch.object(api.Path, "home", return_value=self.home)
        self._home.start()

    def tearDown(self):
        self._home.stop()
        self._env.stop()
        self._tmp.cleanup()

    def write(self, rel: str, data, *, raw: bytes | None = None) -> Path:
        path = (self.home / rel) if not os.path.isabs(rel) else Path(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw if raw is not None else json.dumps(data).encode())
        return path


class ResolveSource(FakeHome):
    def test_priority_settings_then_config_then_pywal(self):
        self.assertEqual(api.resolve_source("  ~/p.json ", {"source": "~/c.json"}), ("~/p.json", "settings"))
        self.assertEqual(api.resolve_source("", {"source": "~/c.json"}), ("~/c.json", "config"))
        self.assertEqual(api.resolve_source("", None), (api.PYWAL_PATH, "default"))
        self.assertEqual(api.resolve_source(None, {"source": ""}), (api.PYWAL_PATH, "default"))


class ResolvePath(FakeHome):
    def test_expands_tilde_inside_home(self):
        self.assertEqual(api.resolve_path("~/.cache/wal/colors.json"), self.home / ".cache/wal/colors.json")

    def test_rejects_relative_blank_and_outside(self):
        for bad, reason in (("", "no palette path"), ("cache/x.json", "absolute"),
                            (str(self.outside / "x.json"), "outside"), ("/etc/passwd", "outside")):
            with self.subTest(bad=bad), self.assertRaises(api.PaletteError) as caught:
                api.resolve_path(bad)
            self.assertIn(reason, str(caught.exception))

    def test_symlink_out_of_home_is_outside(self):
        target = self.write(str(self.outside / "leak.json"), FLAT)
        link = self.home / "palette.json"
        link.symlink_to(target)
        with self.assertRaises(api.PaletteError):
            api.resolve_path(str(link))

    def test_dotdot_cannot_climb_out(self):
        with self.assertRaises(api.PaletteError):
            api.resolve_path(f"{self.home}/../outside/x.json")

    def test_xdg_dirs_are_allowed_when_set(self):
        with mock.patch.dict(os.environ, {"XDG_CACHE_HOME": str(self.outside)}):
            self.assertEqual(api.resolve_path(str(self.outside / "wal/colors.json")), self.outside / "wal/colors.json")


class Projection(FakeHome):
    def test_pywal_keeps_only_colours(self):
        out = api.project_palette(PYWAL)
        self.assertEqual(set(out), {"special", "colors"})
        self.assertEqual(out["special"], {"background": "#0f1417", "foreground": "#c3c5c7"})
        self.assertEqual(len(out["colors"]), 16)
        self.assertNotIn("wallpaper", json.dumps(out))

    def test_flat_keeps_only_known_colour_keys(self):
        out = api.project_palette(FLAT)
        self.assertEqual(out, {"background": "#151817", "foreground": "#f5f6f8", "surface": "#252927",
                               "accent": "#b4c3be", "selection_text": "#06090a"})

    def test_unrelated_json_is_not_a_palette(self):
        for doc in ({"token": "sk-live-abc"}, {"background": "#000"}, ["#000", "#fff"], "x", None,
                    {"special": {"background": "#000"}, "colors": {}}):
            with self.subTest(doc=doc):
                self.assertIsNone(api.project_palette(doc))

    def test_non_colour_strings_are_dropped(self):
        self.assertIsNone(api.project_palette({"background": "url(http://x)", "foreground": "#fff"}))
        self.assertEqual(api.project_palette({"background": "0f1417", "foreground": "#FFF", "accent": "red"}),
                         {"background": "0f1417", "foreground": "#FFF"})


class PaletteRoute(FakeHome):
    def test_pywal_by_default_with_stamp_short_circuit(self):
        self.write(".cache/wal/colors.json", PYWAL)
        first = api.palette_reply()
        self.assertTrue(first["ok"])
        self.assertEqual((first["path"], first["origin"]), (api.PYWAL_PATH, "default"))
        self.assertEqual(first["palette"]["special"]["background"], "#0f1417")

        again = api.palette_reply(since=first["stamp"])
        self.assertEqual(again, {"ok": True, "unchanged": True, "stamp": first["stamp"],
                                 "path": api.PYWAL_PATH, "origin": "default"})

        changed = dict(PYWAL, special=dict(PYWAL["special"], background="#1d1020"))
        path = self.write(".cache/wal/colors.json", changed)
        os.utime(path, ns=(1, 1))  # guarantee a different mtime even on coarse filesystems
        third = api.palette_reply(since=first["stamp"])
        self.assertTrue(third["ok"])
        self.assertNotIn("unchanged", third)
        self.assertEqual(third["palette"]["special"]["background"], "#1d1020")

    def test_config_file_source_and_settings_override(self):
        self.write(".cache/wal/colors.json", PYWAL)
        self.write(".config/hermes-wallpaper-theme/config.json", {"source": "~/.local/share/wal-glass/palette.json"})
        self.write(".local/share/wal-glass/palette.json", FLAT)
        self.write("mine.json", dict(FLAT, background="#222222"))

        from_config = api.palette_reply()
        self.assertEqual(from_config["origin"], "config")
        self.assertEqual(from_config["palette"]["background"], "#151817")

        from_settings = api.palette_reply(path="~/mine.json")
        self.assertEqual(from_settings["origin"], "settings")
        self.assertEqual(from_settings["palette"]["background"], "#222222")

    def test_failures_are_short_reasons_without_contents(self):
        self.assertEqual(api.palette_reply(), {"ok": False, "error": "no such file", "path": api.PYWAL_PATH,
                                               "origin": "default"})
        self.write(".cache/wal/colors.json", None, raw=b'{"special": {')
        self.assertEqual(api.palette_reply()["error"], "not valid JSON")
        self.write("secret.json", {"api_key": "sk-live-abc"})
        reply = api.palette_reply(path="~/secret.json")
        self.assertFalse(reply["ok"])
        self.assertNotIn("sk-live", json.dumps(reply))
        self.assertEqual(api.palette_reply(path="/etc/hostname")["error"], "outside your home directory")
        self.assertEqual(api.palette_reply(path=str(self.home))["error"], "not a regular file")
        self.write("big.json", None, raw=b"[" + b"0," * (api.MAX_BYTES // 2) + b"0]")
        self.assertEqual(api.palette_reply(path="~/big.json")["error"], "larger than 256 KiB")

    def test_unsupported_config_falls_through_to_pywal(self):
        self.write(".cache/wal/colors.json", PYWAL)
        self.write(".config/hermes-wallpaper-theme/config.json", None, raw=b"not json")
        self.assertEqual(api.palette_reply()["origin"], "default")

    def test_route_is_registered_under_palette(self):
        self.assertEqual([r.path for r in api.router.routes], ["/palette"])


if __name__ == "__main__":
    unittest.main()
