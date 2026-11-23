"""Tipos e impressão canônica. Contrato em SPEC.md."""


class TVar:
    def __init__(self):
        raise NotImplementedError


class TCon:
    def __init__(self, name):
        raise NotImplementedError


class TFun:
    def __init__(self, arg, res):
        raise NotImplementedError


class TRec:
    def __init__(self, fields, row=None):
        raise NotImplementedError


class Scheme:
    def __init__(self, vars, type_):
        raise NotImplementedError


INT = None
BOOL = None


def fresh():
    raise NotImplementedError


def pretty(t):
    raise NotImplementedError
