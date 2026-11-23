"""Modelo de dados e exceções do minicfg. Sem lógica de parse ou resolução (ver codec.py e resolver.py)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Union


@dataclass(frozen=True)
class Ref:
    """Referência ${section.key}."""

    section: str
    key: str


@dataclass(frozen=True)
class Interp:
    """String entre aspas com ao menos uma referência: partes são str literais (não vazias) ou Ref."""

    parts: tuple


Scalar = Union[bool, int, float, str]
Value = Union[bool, int, float, str, Ref, Interp]


@dataclass(frozen=True)
class Entry:
    key: str
    value: Value


@dataclass(frozen=True)
class Section:
    name: str
    entries: tuple = ()


@dataclass(frozen=True)
class Document:
    sections: tuple = ()


class ParseError(ValueError):
    def __init__(self, line: int, message: str):
        self.line = line
        super().__init__(f"linha {line}: {message}")


class ResolveError(ValueError):
    pass


class UnknownReferenceError(ResolveError):
    pass


class CycleError(ResolveError):
    def __init__(self, path):
        self.path = list(path)
        super().__init__("ciclo de referência: " + " -> ".join(f"{s}.{k}" for s, k in self.path))
