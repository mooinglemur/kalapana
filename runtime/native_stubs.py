"""Stand-ins for modules some apworlds import only for their game clients: Dolphin memory access
(dolphin_memory_engine) and desktop dialogs (tkinter). Neither exists in Pyodide, and a failed import
keeps the whole world from loading even though a tracker never runs its client.

Importing works, including names taken from submodules (`from tkinter.filedialog import askopenfilename`).
Calling anything raises: tkinter.TclError for tkinter, which AP's own dialog helpers already treat as "no
GUI available", and RuntimeError otherwise.
"""
import importlib.abc
import importlib.machinery
import importlib.util
import sys
import types


class TclError(Exception):
    """tkinter's error, as a real class so `except tkinter.TclError` still works."""


MODULES: dict[str, type[Exception]] = {
    "dolphin_memory_engine": RuntimeError,
    "tkinter": TclError,
}


class Unavailable:
    """A name taken from a stand-in module. Attribute access chains; calling raises."""

    def __init__(self, name: str, error: type[Exception]):
        self._name = name
        self._error = error

    def __getattr__(self, attribute):
        if attribute.startswith("__"):
            raise AttributeError(attribute)
        return Unavailable(f"{self._name}.{attribute}", self._error)

    def __call__(self, *args, **kwargs):
        raise self._error(f"{self._name} is not available in the browser")

    def __repr__(self):
        return f"<unavailable {self._name}>"


class _Loader(importlib.abc.Loader):
    def create_module(self, spec):
        module = types.ModuleType(spec.name)
        root = spec.name.split(".")[0]
        error = MODULES[root]
        # A package, so submodules such as tkinter.filedialog import too.
        module.__path__ = []
        if spec.name == "tkinter":
            module.TclError = TclError

        def attribute(name, prefix=spec.name):
            if name.startswith("__"):
                raise AttributeError(name)
            return Unavailable(f"{prefix}.{name}", error)

        module.__getattr__ = attribute
        return module

    def exec_module(self, module):
        pass


class _Finder(importlib.abc.MetaPathFinder):
    def __init__(self, roots):
        self.roots = frozenset(roots)

    def find_spec(self, fullname, path, target=None):
        if fullname.split(".")[0] not in self.roots:
            return None
        return importlib.machinery.ModuleSpec(fullname, _Loader(), is_package=True)


def install() -> None:
    """Adds stand-ins for whichever MODULES this interpreter can't import, last on the meta path."""
    if any(isinstance(finder, _Finder) for finder in sys.meta_path):
        return
    missing = [name for name in MODULES if importlib.util.find_spec(name) is None]
    if missing:
        sys.meta_path.append(_Finder(missing))
