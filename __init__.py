"""Wallpaper Theme — agent half.

The theme itself is ``desktop/plugin.js``. This package exists so Hermes treats the
repository as one installable plugin and mounts ``dashboard/plugin_api.py`` (the
palette-file reader) once ``wallpaper-theme`` is in ``plugins.enabled``.

It registers no tools, hooks, commands or environment variables.
"""


def register(ctx):  # noqa: ARG001 - nothing to register; the backend mounts from dashboard/manifest.json
    """Intentionally empty."""
