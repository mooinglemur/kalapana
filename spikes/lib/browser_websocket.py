"""Stand-in for `websockets.connect` backed by the JavaScript WebSocket API.

Covers only what CommonClient uses: awaiting connect, `open`/`closed`, `send`, `close`,
and async iteration over text frames.
"""
import asyncio

import js
from pyodide.ffi import create_proxy

_CLOSED = object()


class BrowserWebSocket:
    def __init__(self, uri: str):
        loop = asyncio.get_running_loop()
        self._opened = loop.create_future()
        self._messages: asyncio.Queue = asyncio.Queue()
        self.open = False
        self.closed = False

        self._ws = js.WebSocket.new(uri)
        self._handlers = {
            "open": create_proxy(self._on_open),
            "message": create_proxy(self._on_message),
            "error": create_proxy(self._on_error),
            "close": create_proxy(self._on_close),
        }
        for name, handler in self._handlers.items():
            self._ws.addEventListener(name, handler)

    def _on_open(self, _event):
        self.open = True
        if not self._opened.done():
            self._opened.set_result(None)

    def _on_message(self, event):
        if isinstance(event.data, str):
            self._messages.put_nowait(event.data)

    def _on_error(self, _event):
        # The browser hides error details; the close event that follows ends iteration.
        if not self._opened.done():
            self._opened.set_exception(ConnectionRefusedError("WebSocket connection failed"))

    def _on_close(self, _event):
        self.open = False
        self.closed = True
        if not self._opened.done():
            self._opened.set_exception(ConnectionRefusedError("WebSocket closed before opening"))
        self._messages.put_nowait(_CLOSED)
        for name, handler in self._handlers.items():
            self._ws.removeEventListener(name, handler)
            handler.destroy()

    async def send(self, data: str) -> None:
        self._ws.send(data)

    async def close(self) -> None:
        if not self.closed:
            self._ws.close()

    def __aiter__(self):
        return self

    async def __anext__(self) -> str:
        message = await self._messages.get()
        if message is _CLOSED:
            raise StopAsyncIteration
        return message


async def connect(uri: str, **_kwargs) -> BrowserWebSocket:
    # TLS, ping and max_size are handled by the browser, so CommonClient's extra arguments are ignored.
    # CommonClient retries with wss:// after a websockets.InvalidMessage, but the browser only reports
    # a generic failure, so retry here instead.
    try:
        socket = BrowserWebSocket(uri)
        await socket._opened
    except ConnectionRefusedError:
        if not uri.startswith("ws://"):
            raise
        socket = BrowserWebSocket("wss://" + uri[len("ws://"):])
        await socket._opened
    return socket


def install() -> None:
    import websockets
    websockets.connect = connect
