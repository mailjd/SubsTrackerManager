"""Independent local disk assertions through Node's built-in SQLite engine.

This is a deliberately small test utility, not a sqlite3 compatibility shim.
It never imports sqlite3/_sqlite3, uses pip, or contacts a remote database.
"""
import base64
import json
import math
import os
from pathlib import Path
import shutil
import subprocess

NODE = os.environ.get("SUBSTRACKER_TEST_NODE") or shutil.which("node") or "node"
BRIDGE = Path(__file__).with_name("sqlite-local.mjs").resolve()
LIMIT = 16 * 1024 * 1024


def _encode(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        if not -(2**63) <= value < 2**63:
            raise ValueError("SQL integer is outside int64")
        return {"type": "integer", "value": str(value)}
    if isinstance(value, str):
        return {"type": "text", "value": value}
    if isinstance(value, float) and math.isfinite(value):
        return {"type": "real", "value": value}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"type": "blob", "value": base64.b64encode(value).decode("ascii")}
    raise TypeError("Unsupported SQL parameter type")


def _decode(value):
    kind = value["type"]
    if kind == "null":
        return None
    if kind == "integer":
        return int(value["value"])
    if kind == "text":
        return value["value"]
    if kind == "real":
        return float(value["value"])
    if kind == "blob":
        return base64.b64decode(value["value"], validate=True)
    raise ValueError("Unsupported SQL result type")


def _request(database, mode, statements):
    database = Path(database).absolute()
    if database.is_symlink() or not database.is_file():
        raise FileNotFoundError("Existing regular local SQLite fixture required: " + str(database))
    payload = json.dumps({
        "protocol": 1, "database": str(database), "mode": mode,
        "fixtureWrites": mode == "fixture-transaction",
        "statements": [{"sql": sql, "params": [_encode(p) for p in params]}
                       for sql, params in statements],
    }, ensure_ascii=True, allow_nan=False)
    if len(payload.encode("utf8")) > LIMIT:
        raise ValueError("Local SQL fixture request exceeds size limit")
    try:
        result = subprocess.run([NODE, str(BRIDGE)], input=payload, text=True,
                                encoding="utf8", capture_output=True, timeout=30,
                                check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("ST_TEST_SQLITE: Node local SQLite process unavailable") from error
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ST_TEST_SQLITE: local query failed")
    if len(result.stdout.encode("utf8")) > LIMIT:
        raise RuntimeError("ST_TEST_SQLITE: response exceeds size limit")
    output = json.loads(result.stdout)
    if output.get("protocol") != 1 or output.get("ok") is not True or len(output.get("results", [])) != len(statements):
        raise RuntimeError("ST_TEST_SQLITE: incomplete response")
    return output["results"]


def query_rows(database, sql, params=()):
    """Read an existing fixture directly, in a separate read-only Node process."""
    result = _request(database, "read", [(sql, params)])[0]
    columns = result["columns"]
    rows = result["rows"]
    if any(len(row) != len(columns) for row in rows):
        raise RuntimeError("ST_TEST_SQLITE: incomplete row")
    return [tuple(_decode(value) for value in row) for row in rows]


def execute_transaction(database, statements):
    """Explicit fixture-only writes, committed together or all rolled back."""
    results = _request(database, "fixture-transaction", list(statements))
    return [{key: _decode(value) for key, value in result.items()} for result in results]
