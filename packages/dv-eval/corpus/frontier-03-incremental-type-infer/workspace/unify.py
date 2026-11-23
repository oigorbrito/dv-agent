"""Unificação com registros de linha. Contrato em SPEC.md."""
from ast_types import TVar  # noqa: F401


class TypeErr(Exception):
    def __init__(self, message, origin=()):
        raise NotImplementedError


class Subst:
    def __init__(self):
        raise NotImplementedError


def unify(subst, a, b, origin=()):
    raise NotImplementedError
