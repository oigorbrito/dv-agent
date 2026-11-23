"""Interpretador e construção de SSA. Contrato em SPEC.md."""
from cfg import successors  # noqa: F401


def interpret(f, args, fuel=10000):
    raise NotImplementedError


def to_ssa(f):
    raise NotImplementedError
