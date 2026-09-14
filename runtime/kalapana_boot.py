"""Prepares Pyodide's interpreter for Archipelago. Shared by the browser runtime and the analyzer.

Expects the core bundle unpacked at / (AP under /ap, vendored modules under /site-packages).
"""
import concurrent.futures
import concurrent.futures.thread
import os
import sys

AP_ROOT = "/ap"
SITE_PACKAGES = "/site-packages"


class InlineExecutor(concurrent.futures.Executor):
    """Runs submitted work immediately, since Pyodide cannot start threads."""

    def __init__(self, *args, **kwargs):
        pass

    def submit(self, fn, /, *args, **kwargs):
        future = concurrent.futures.Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as e:
            future.set_exception(e)
        return future


def prepare() -> None:
    concurrent.futures.ThreadPoolExecutor = InlineExecutor
    concurrent.futures.thread.ThreadPoolExecutor = InlineExecutor

    # Vendored stubs (ssl, ModuleUpdate, ...) must win over anything else with the same name.
    for path in (SITE_PACKAGES, AP_ROOT):
        if path in sys.path:
            sys.path.remove(path)
    sys.path[:0] = [SITE_PACKAGES, AP_ROOT]

    try:
        import ssl  # noqa: F401  (Pyodide's ssl package, loaded only for worlds that use requests)
    except ImportError:
        import ssl_stub

        sys.modules["ssl"] = ssl_stub

    import native_stubs

    native_stubs.install()

    # A missing Players folder makes settings fall back to a native folder dialog.
    os.makedirs(os.path.join(AP_ROOT, "Players"), exist_ok=True)
    os.makedirs(os.path.join(AP_ROOT, "custom_worlds"), exist_ok=True)
    os.chdir(AP_ROOT)
    os.environ["SKIP_REQUIREMENTS_UPDATE"] = "1"

    # UT and CommonClient decide GUI mode from argv when Utils is first imported.
    sys.argv = ["UniversalTracker", "--nogui"]
    import settings

    # A missing required file raises instead of opening a native file dialog.
    settings.no_gui = True
