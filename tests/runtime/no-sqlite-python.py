"""Failure-injection runner: reject Python SQLite imports, do NOT fake SQL data.

Used only by regression tests to reproduce the reported incomplete Python build.
SQLite queries in fixed tests still execute in a real, separate Node process.
"""
import importlib.abc
import runpy
import sys

class NoPythonSQLite(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".", 1)[0] in ("sqlite3", "_sqlite3"):
            raise ModuleNotFoundError("No module named '" + fullname + "'", name=fullname)

sys.dont_write_bytecode = True
sys.meta_path.insert(0, NoPythonSQLite())
args = sys.argv[1:]
if not args:
    raise SystemExit("Expected a script or -c code")
if args[0] == "-c":
    sys.argv = ["-c", *args[2:]]
    exec(compile(args[1], "<no-sqlite-fixture>", "exec"), {"__name__": "__main__"})
else:
    sys.argv = args
    runpy.run_path(args[0], run_name="__main__")
