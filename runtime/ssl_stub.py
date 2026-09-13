"""Stand-in for ssl when Pyodide's ssl package isn't loaded.

CommonClient imports ssl at load time but only uses it for wss://, which the browser handles. Worlds that
use requests need the real module, so kalapana_boot installs this only when ssl can't be imported.
"""


class Purpose:
    SERVER_AUTH = "SERVER_AUTH"


class SSLContext:
    pass


def create_default_context(*args, **kwargs):
    raise NotImplementedError("TLS is handled by the browser")
