"""Just enough MCP: initialize, ping, tools/list, tools/call. Stateless (no sessions, no server-to-client messages)."""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import jsonschema

from .. import __version__

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")  # newest first
MAX_RESULT_BYTES = 200_000

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL = -32700, -32600, -32601, -32602, -32603

INSTRUCTIONS = (
    "Read-only access to one school's Kerf laser-cutting system: the files pupils have submitted, the queue, and the laser stations. "
    "Pupils appear by ID (and by display name only for staff of their own school). Nothing here can change a file, the queue or a station."
)


class ToolError(Exception):
    """A problem the model should read and react to (not found, bad filter). Returned as an `isError` result, not a protocol error."""


@dataclass(frozen=True)
class Tool:
    name: str
    title: str
    description: str
    schema: dict[str, Any]
    run: Callable[[Any, dict[str, Any]], dict[str, Any]]  # (ToolContext, arguments) -> JSON-able dict

    def listing(self) -> dict[str, Any]:
        return {
            "name": self.name, "title": self.title, "description": self.description, "inputSchema": self.schema,
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
        }


def _err(id_: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def _ok(id_: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def _tool_result(payload: dict[str, Any] | None, error: str | None = None) -> dict[str, Any]:
    if error is not None:
        return {"content": [{"type": "text", "text": error}], "isError": True}
    text = json.dumps(payload, separators=(",", ":"), default=str)
    if len(text.encode()) > MAX_RESULT_BYTES:
        return _tool_result(None, "That answer is too large to return. Ask for fewer items (limit/offset) or leave out the design.")
    return {"content": [{"type": "text", "text": text}], "structuredContent": payload, "isError": False}


def handle(msg: Any, tools: dict[str, Tool], ctx_factory: Callable[[], Any], log: Callable[[str, bool], None]) -> dict[str, Any] | None:
    """One JSON-RPC message in, one response out (None for notifications and for the client's own responses)."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _err(None, INVALID_REQUEST, "Send a JSON-RPC 2.0 message.")
    method, id_ = msg.get("method"), msg.get("id")
    if method is None:  # a response from the client: nothing to do
        return None
    if not isinstance(method, str):
        return _err(id_, INVALID_REQUEST, "method must be text.")
    if "id" not in msg:  # a notification (e.g. notifications/initialized): never answered
        return None
    params = msg.get("params") or {}
    if not isinstance(params, dict):
        return _err(id_, INVALID_PARAMS, "params must be an object.")

    if method == "initialize":
        asked = params.get("protocolVersion")
        return _ok(id_, {
            "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "kerf-server", "title": "Kerf Server", "version": __version__},
            "instructions": INSTRUCTIONS,
        })
    if method == "ping":
        return _ok(id_, {})
    if method == "tools/list":
        return _ok(id_, {"tools": [t.listing() for t in tools.values()]})
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        tool = tools.get(name) if isinstance(name, str) else None
        if tool is None:
            return _err(id_, INVALID_PARAMS, f"Unknown tool {name!r}.")
        try:
            jsonschema.validate(args, tool.schema)
        except jsonschema.ValidationError as e:
            return _err(id_, INVALID_PARAMS, f"Bad arguments for {tool.name}: {e.message}")
        try:
            result = _tool_result(tool.run(ctx_factory(), args))
        except ToolError as e:
            result = _tool_result(None, str(e))
        except Exception:  # a bug must not leak internals to the model; the server log has the traceback
            import logging

            logging.getLogger("kerf.mcp").exception("tool %s failed", tool.name)
            result = _tool_result(None, "Something went wrong reading that. Try again, or ask for less.")
        log(tool.name, not result["isError"])
        return _ok(id_, result)
    return _err(id_, METHOD_NOT_FOUND, f"Unsupported method {method!r}.")
