"""riff-connect-hermes: connects this Hermes to a Riff board through the user's own Worker.

What it does, inside Hermes:

* Opens one WebSocket from this computer to the Worker and keeps it open (only in the
  gateway process). Riff's requests come down it and are made to Hermes's own API on
  127.0.0.1; the answers go back in pieces, so a stream of words arrives as it is
  written. Nothing on this computer accepts a connection from outside.
* Adds the Riff tools (riff_list_riffs, riff_request_card, riff_request_status). They
  call the Worker's MCP door with this Hermes's key.
* Sends each tool step (the tool, a short preview of its input and result) to the
  Worker, so Riff can show what Hermes did even while Chrome was closed.

Setting up (0.2): Riff shows a message to paste into Hermes, with the Worker's address and a
one-time code; Hermes calls the riff_connect_pair tool, which pairs and saves the address and
this Hermes's key in ~/.hermes/riff-connect-hermes.json (readable by this user only). The
gateway's link picks it up within seconds. No settings file to edit.

Also read, for a manual setup: RIFF_CONNECT_URL and RIFF_CONNECT_CODE in ~/.hermes/.env.
RIFF_CONNECT_LINK=always|never overrides where the WebSocket is opened.
"""

import asyncio
import codecs
import json
import logging
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "0.2.1"
START_DELAY = float(os.environ.get("RIFF_CONNECT_START_DELAY") or 8)
log = logging.getLogger("riff-connect-hermes")
HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
STATE = HOME / "riff-connect-hermes.json"
PREVIEW = 300
# The only parts of Hermes's API the Worker may ask for (the Worker checks this too).
ALLOWED = ("/v1/", "/api/sessions", "/health")
PASS_HEADERS = ("content-type", "accept", "idempotency-key", "last-event-id")
_ctx = None


# ---------------------------------------------------------------- settings

def _env(name, default=""):
    v = os.environ.get(name)
    if v:
        return v.strip()
    # Hermes keeps its settings in ~/.hermes/.env; read it if this process didn't load it.
    try:
        for line in (HOME / ".env").read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == name:
                return v.strip().strip('"').strip("'")
    except OSError:
        pass
    return default


def _url():
    # The address saved by riff_connect_pair, else the one in ~/.hermes/.env.
    return (_saved().get("url") or _env("RIFF_CONNECT_URL")).rstrip("/")


def _local_base():
    return "http://127.0.0.1:%s" % _env("API_SERVER_PORT", "8642")


def _clip(v, n=PREVIEW):
    if v is None:
        return ""
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
    s = " ".join(s.split())[:n]
    try:
        if _ctx is not None and hasattr(_ctx, "redact_text"):
            s = _ctx.redact_text(s)
    except Exception:
        pass
    return s


def _hermes_version():
    try:
        import hermes_cli  # type: ignore

        return str(getattr(hermes_cli, "__version__", ""))[:40]
    except Exception:
        return ""


# ---------------------------------------------------------------- the key (pairing)

_key_lock = threading.Lock()


def _tls():
    # Python from python.org on macOS has no certificates until "Install Certificates" is run,
    # so HTTPS calls fail there. Use certifi's when it's installed (aiohttp usually brings it).
    import ssl

    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _http(method, url, body=None, key=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", "user-agent": "riff-connect-hermes/" + VERSION}
    if key:
        headers["authorization"] = "Bearer " + key
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_tls() if url.startswith("https:") else None) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except Exception:
            return e.code, None


def _saved():
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {}


class PairingRefused(RuntimeError):
    pass


# A code the Worker refused is never sent again: every wrong try counts toward the
# Worker's lock-out (8 in 15 minutes), which would also lock out Riff's own pairing.
_bad_code = {"code": None}


class NotSetUp(RuntimeError):
    pass


def _save(url, key):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps({"key": key, "url": url, "at": int(time.time())}))
    try:
        os.chmod(STATE, 0o600)
    except OSError:
        pass


def _pair():
    code = _env("RIFF_CONNECT_CODE")
    if not _url() or not code:
        raise NotSetUp("Not connected to Riff yet. In Riff › Models, add \"Hermes agent, through Riff Connect\" and paste the message it gives you into Hermes.")
    if code == _bad_code["code"]:
        raise PairingRefused("The Worker refused RIFF_CONNECT_CODE. Put the Worker's pairing code in ~/.hermes/.env, then run: hermes gateway restart")
    status, j = _http("POST", _url() + "/pair/hermes", {"code": code, "name": socket.gethostname()[:60]})
    if status == 403:
        _bad_code["code"] = code
        raise PairingRefused("The Worker refused RIFF_CONNECT_CODE (not its pairing code). Put the right one in ~/.hermes/.env, then run: hermes gateway restart")
    if status == 429:
        raise PairingRefused("The Worker is locked after too many wrong codes. It opens again within 15 minutes.")
    if status != 200 or not (j or {}).get("hermesKey"):
        raise RuntimeError("Pairing with %s failed (%s): %s" % (_url(), status, (j or {}).get("error", "")))
    _save(_url(), j["hermesKey"])
    log.info("riff-connect-hermes: paired with %s", _url())
    return j["hermesKey"]


def _key(fresh=False):
    """This Hermes's key for the Worker. Pairs (once) with the code in ~/.hermes/.env when there
    is none, or when fresh=True (the old one was refused)."""
    with _key_lock:
        s = _saved()
        if not fresh and s.get("key") and s.get("url") == _url():
            return s["key"]
        return _pair()


def _connect_pair(args, **kwargs):
    """riff_connect_pair: the Worker's address and a one-time code from Riff › Models."""
    try:
        raw = str((args or {}).get("address") or "").strip().rstrip("/")
        code = str((args or {}).get("code") or "").strip()
        if not raw or not code:
            return json.dumps({"error": "Give both: the address (https://….workers.dev) and the one-time code from Riff › Models."})
        url = raw if raw.startswith(("https://", "http://")) else "https://" + raw
        if not url.startswith("https://") and not url.startswith(("http://127.0.0.1", "http://localhost")):
            return json.dumps({"error": "The address must start with https://"})
        status, j = _http("POST", url + "/pair/hermes", {"code": code, "name": socket.gethostname()[:60]})
        if status != 200 or not (j or {}).get("hermesKey"):
            why = str((j or {}).get("error") or "unknown error").rstrip(".")
            hint = " The code works once, for 15 minutes: ask Riff for a new one (Models › your Riff Connect agent › New code)." if status == 403 else ""
            return json.dumps({"error": "Riff Connect refused (%s): %s.%s" % (status, why, hint)})
        with _key_lock:
            _save(url, j["hermesKey"])
        LINK.wake()
        # 0.2.1: say only what is true. Ask the Worker whether the gateway's link came up.
        for _ in range(15):
            time.sleep(2)
            try:
                st, info = _http("GET", url + "/?t=%d" % int(time.time() * 1000))
                if st == 200 and ((info or {}).get("hermes") or {}).get("connected"):
                    return json.dumps({"result": "Paired and connected: Riff can reach this Hermes through %s. Riff › Models shows Connected. Do not run any 'hermes gateway' command now; it isn't needed." % url})
            except Exception:  # noqa: BLE001
                pass
        return json.dumps({"result": "Paired with %s, but the Hermes gateway hasn't linked to it within 30 seconds. Ask the user to check that the gateway is running (hermes gateway status) and, if it is, to restart it once with: hermes gateway restart. Do not restart it yourself." % url})
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": "Pairing failed: %s: %s" % (type(e).__name__, e)})


# ---------------------------------------------------------------- the Riff tools

def _schema(name, description, properties=None, required=None):
    return {"name": name, "description": description, "parameters": {"type": "object", "properties": properties or {}, "required": required or []}}


SCHEMAS = [
    _schema(
        "riff_list_riffs",
        "Lists the riffs (ready-made card types) that can be put on the user's Riff board, with the fields each one takes. Call this before riff_request_card.",
    ),
    _schema(
        "riff_request_card",
        "Asks for a card on the user's Riff board. The card appears in the Ideas lane the next time the user has Riff open. It does not run: the user decides whether to make it ready and run it. Use it when the user asks you to add, queue or plan a task for their Riff board.",
        {
            "riff": {"type": "string", "description": 'The riff id, from riff_list_riffs (for example "search-x").'},
            "title": {"type": "string", "description": "A short name for the card. Optional."},
            "inputs": {"type": "object", "description": 'The riff\'s fields by id, as strings (for example {"topics": "on-device AI"}).'},
            "goal": {"type": "integer", "description": "How many results the card should reach. Optional; the riff has a default."},
            "why": {"type": "string", "description": "One sentence for the user on why you are asking for this card. Optional."},
        },
        ["riff"],
    ),
    _schema(
        "riff_connect_pair",
        "Connects this Hermes to the user's Riff (a browser extension) through their Riff Connect Worker. Use it when the user pastes a message from Riff with an address and a one-time code, or asks to connect Hermes to Riff.",
        {
            "address": {"type": "string", "description": "The Riff Connect Worker's address, for example https://riff-connect-hermes.name.workers.dev"},
            "code": {"type": "string", "description": "The one-time code Riff showed, for example K7QM-3XRA"},
        },
        ["address", "code"],
    ),
    _schema(
        "riff_request_status",
        "Says what became of a card request you made: still waiting for Riff to open, accepted onto the board (in Ideas), or rejected with the reason. You cannot see the rest of the board.",
        {"request": {"type": "string", "description": "The request id that riff_request_card returned."}},
        ["request"],
    ),
]


def _call_tool(name, args):
    """Calls the Worker's MCP door. Always returns a JSON string; never raises."""
    if not _url():
        return json.dumps({"error": "This Hermes isn't connected to Riff yet. In Riff › Models, add \"Hermes agent, through Riff Connect\" and paste the message it gives you here."})
    try:
        status, j = 0, None
        for attempt in (0, 1):
            status, j = _http("POST", _url() + "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args or {}}}, key=_key(fresh=attempt == 1))
            if status != 401:
                break
        if status != 200:
            return json.dumps({"error": "The Riff connector answered %s: %s" % (status, (j or {}).get("error", ""))})
        res = (j or {}).get("result") or {}
        text = "\n".join(c.get("text", "") for c in res.get("content", []) if isinstance(c, dict))
        return json.dumps({"error": text} if res.get("isError") else {"result": text}, ensure_ascii=False)
    except Exception as e:  # noqa: BLE001
        return json.dumps({"error": "The Riff connector couldn't be reached at %s: %s: %s" % (_url() or "(RIFF_CONNECT_URL is not set)", type(e).__name__, e)})


def _handler(name):
    def handle(args, **kwargs):
        return _call_tool(name, args if isinstance(args, dict) else {})

    return handle


# ---------------------------------------------------------------- the link to the Worker

class Link:
    """One WebSocket to the Worker, in a thread of its own with its own event loop."""

    def __init__(self):
        self.loop = None
        self.out = None
        self.http = None
        self.tasks = {}
        self.thread = None
        self.connected = False
        self.woken = None  # asyncio.Event, set by wake() from any thread

    def start(self):
        if self.thread:
            return
        self.thread = threading.Thread(target=self._run, name="riff-connect-hermes", daemon=True)
        self.thread.start()

    def _run(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._main())
        except Exception as e:  # noqa: BLE001
            log.error("riff-connect-hermes: the link stopped: %s", e)

    def wake(self):
        """Try to connect now (riff_connect_pair just saved an address and key)."""
        loop, ev = self.loop, self.woken
        if loop is not None and ev is not None:
            try:
                loop.call_soon_threadsafe(ev.set)
            except RuntimeError:
                pass

    def send(self, frame):
        """Queue a frame for the Worker, from any thread. Dropped when not connected."""
        loop, q = self.loop, self.out
        if loop is not None and q is not None:
            try:
                loop.call_soon_threadsafe(q.put_nowait, frame)
            except RuntimeError:
                pass

    def _put(self, frame):
        if self.out is not None:
            self.out.put_nowait(frame)

    async def _main(self):
        try:
            import aiohttp
        except ImportError:
            log.error("riff-connect-hermes: aiohttp is missing, so Riff can't reach Hermes through the Worker. The Riff tools still work.")
            return
        self.aiohttp = aiohttp
        self.woken = asyncio.Event()
        # 0.2.1: wait a moment before linking, so a process that only starts and exits never
        # takes the link from the gateway that is already running.
        await asyncio.sleep(START_DELAY)
        backoff, fresh = 1, False
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=15)) as http:
            self.http = http
            while True:
                wait = None
                try:
                    key = await asyncio.to_thread(_key, fresh)
                    fresh = False
                    ws_url = _url().replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/link"
                    async with http.ws_connect(ws_url, headers={"authorization": "Bearer " + key}, autoping=True, max_msg_size=8 * 1024 * 1024) as ws:
                        log.info("riff-connect-hermes: connected to %s", _url())
                        self.connected, backoff = True, 1
                        self.out = asyncio.Queue()
                        await ws.send_str(json.dumps({"t": "hello", "v": VERSION, "hermes": _hermes_version(), "host": socket.gethostname()[:60]}))
                        sender = asyncio.create_task(self._sender(ws))
                        pinger = asyncio.create_task(self._pinger(ws))
                        try:
                            async for msg in ws:
                                if msg.type == aiohttp.WSMsgType.TEXT:
                                    self._on(msg.data)
                                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                                    break
                        finally:
                            self.connected = False
                            sender.cancel()
                            pinger.cancel()
                            self.out = None
                            for t in list(self.tasks.values()):
                                t.cancel()
                            self.tasks.clear()
                        if ws.close_code == 4000:
                            # Another Hermes process connected in our place: let it keep the link.
                            # 0.2.1: one minute, not ten: the replacer is often a short-lived command.
                            log.warning("riff-connect-hermes: another Hermes process took the link; trying again in a minute")
                            wait = 60
                except aiohttp.WSServerHandshakeError as e:
                    if e.status == 401:
                        fresh = True
                        log.warning("riff-connect-hermes: the Worker refused this Hermes's key; pairing again")
                    else:
                        log.warning("riff-connect-hermes: the Worker answered %s", e.status)
                except asyncio.CancelledError:
                    raise
                except NotSetUp:
                    # Waiting for riff_connect_pair: look again every 15 seconds (it also wakes us).
                    wait = 15
                except PairingRefused as e:
                    # A wrong code waits for a restart with the right one; a lock-out waits it out.
                    log.warning("riff-connect-hermes: %s", e)
                    wait = 300
                except Exception as e:  # noqa: BLE001
                    log.warning("riff-connect-hermes: %s", e)
                self.woken.clear()
                try:
                    await asyncio.wait_for(self.woken.wait(), timeout=wait or backoff)
                    backoff = 1  # woken by a new pairing: try at once
                except asyncio.TimeoutError:
                    backoff = min(backoff * 2, 60)

    async def _sender(self, ws):
        while True:
            f = await self.out.get()
            await ws.send_str(json.dumps(f, ensure_ascii=False))

    async def _pinger(self, ws):
        while True:
            await asyncio.sleep(30)
            await ws.send_str('{"t":"ping"}')  # the Worker answers without waking up

    def _on(self, data):
        try:
            f = json.loads(data)
        except ValueError:
            return
        t, fid = f.get("t"), f.get("id")
        if t == "req" and fid:
            task = asyncio.ensure_future(self._proxy(f))
            self.tasks[fid] = task
            task.add_done_callback(lambda _t, i=fid: self.tasks.pop(i, None))
        elif t == "cancel" and fid in self.tasks:
            self.tasks[fid].cancel()

    async def _proxy(self, f):
        """Makes Riff's request to Hermes on this computer and streams the answer back."""
        aiohttp = self.aiohttp
        fid = f["id"]
        path = str(f.get("path") or "/")
        if not path.startswith(ALLOWED) or ".." in path:
            self._put({"t": "error", "id": fid, "message": "That path isn't open through the connector."})
            return
        headers = {k: v for k, v in (f.get("headers") or {}).items() if k.lower() in PASS_HEADERS}
        api_key = _env("API_SERVER_KEY")
        if api_key:
            headers["authorization"] = "Bearer " + api_key
        body = f.get("body")
        try:
            async with self.http.request(
                str(f.get("method") or "GET"),
                _local_base() + path,
                headers=headers,
                data=body.encode() if isinstance(body, str) else None,
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=None),
            ) as r:
                self._put({"t": "head", "id": fid, "status": r.status, "headers": {"content-type": r.headers.get("content-type", ""), "cache-control": r.headers.get("cache-control", "")}})
                dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
                async for chunk in r.content.iter_any():
                    s = dec.decode(chunk)
                    if s:
                        self._put({"t": "data", "id": fid, "chunk": s})
                tail = dec.decode(b"", final=True)
                if tail:
                    self._put({"t": "data", "id": fid, "chunk": tail})
                self._put({"t": "end", "id": fid})
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self._put({"t": "error", "id": fid, "message": "%s (%s)" % (e, _local_base())})


LINK = Link()


# ---------------------------------------------------------------- tool steps

def _session(kw):
    return str(kw.get("session_id") or kw.get("task_id") or "")[:120]


def _pre_tool(tool_name=None, args=None, **kw):
    LINK.send({"t": "step", "state": "run", "tool": str(tool_name or "tool"), "preview": _clip(args), "session": _session(kw), "call": str(kw.get("tool_call_id") or "")})


def _post_tool(tool_name=None, args=None, result=None, **kw):
    status = str(kw.get("status") or "").lower()
    failed = status in ("error", "failed", "fail") or bool(kw.get("error_message")) or bool(kw.get("error_type"))
    LINK.send(
        {
            "t": "step",
            "state": "fail" if failed else "done",
            "tool": str(tool_name or "tool"),
            "preview": _clip(args),
            "result": _clip(kw.get("error_message") if failed and kw.get("error_message") else result),
            "ms": kw.get("duration_ms") or 0,
            "session": _session(kw),
            "call": str(kw.get("tool_call_id") or ""),
        }
    )


# ---------------------------------------------------------------- start-up

def _should_link(ctx):
    """Only the gateway process holds the link (the CLI would fight it for the Worker)."""
    mode = _env("RIFF_CONNECT_LINK").lower()
    if mode in ("always", "1", "yes", "true"):
        return True
    if mode in ("never", "0", "no", "false"):
        return False
    if getattr(ctx, "_cli_ref", None) is not None:
        return False
    # 0.2.1: "hermes gateway status/restart/stop/..." also load plugins. Those short-lived
    # commands must not link: they took the Worker's socket from the running gateway (Nov 20).
    args = [os.path.basename(a) for a in sys.argv]
    if not any("gateway" in a for a in args):
        return False
    i = next(n for n, a in enumerate(args) if "gateway" in a)
    after = args[i + 1] if i + 1 < len(args) else ""
    return after not in SHORT_LIVED


SHORT_LIVED = {"status", "stop", "restart", "install", "uninstall", "logs", "log", "setup", "enable", "disable", "doctor", "--help", "-h", "help"}


def register(ctx):
    global _ctx
    _ctx = ctx
    for schema in SCHEMAS:
        handler = _connect_pair if schema["name"] == "riff_connect_pair" else _handler(schema["name"])
        ctx.register_tool(name=schema["name"], toolset="riff", schema=schema, handler=handler)
    ctx.register_hook("pre_tool_call", _pre_tool)
    ctx.register_hook("post_tool_call", _post_tool)
    skill = Path(__file__).parent / "skills" / "riff-board" / "SKILL.md"
    if skill.exists() and hasattr(ctx, "register_skill"):
        try:
            ctx.register_skill("riff-board", skill)
        except Exception as e:  # noqa: BLE001
            log.warning("riff-connect-hermes: couldn't add the riff-board skill: %s", e)
    if _should_link(ctx):
        LINK.start()
