"""Tipos e impressão canônica. Contrato em SPEC.md."""
import itertools

_ids = itertools.count(1)
_LETTERS = "abcdefghijklmnopqrstuvwxyz"


class TVar:
    def __init__(self):
        self.id = next(_ids)


class TCon:
    def __init__(self, name):
        self.name = name


class TFun:
    def __init__(self, arg, res):
        self.arg = arg
        self.res = res


class TRec:
    def __init__(self, fields, row=None):
        self.fields = dict(fields)
        self.row = row


class Scheme:
    def __init__(self, vars, type_):
        self.vars = list(vars)
        self.type = type_


INT = TCon("int")
BOOL = TCon("bool")


def fresh():
    return TVar()


def pretty(t):
    names = {}

    def name(v):
        if v.id not in names:
            names[v.id] = _LETTERS[len(names)]
        return names[v.id]

    def go(t, arg_pos=False):
        if isinstance(t, TVar):
            return name(t)
        if isinstance(t, TCon):
            return t.name
        if isinstance(t, TFun):
            s = f"{go(t.arg, True)} -> {go(t.res)}"
            return f"({s})" if arg_pos else s
        parts = [f"{k}: {go(v)}" for k, v in sorted(t.fields.items())]
        if t.row is None:
            return "{" + ", ".join(parts) + "}"
        tail = go(t.row)
        if parts:
            return "{" + ", ".join(parts) + f" | {tail}" + "}"
        return "{| " + tail + "}"

    return go(t)
