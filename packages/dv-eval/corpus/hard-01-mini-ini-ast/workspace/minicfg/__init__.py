"""minicfg: configuração hierárquica com referências ${secao.chave}. Contrato em SPEC.md."""
from .codec import dumps, parse
from .model import (
    CycleError,
    Document,
    Entry,
    Interp,
    ParseError,
    Ref,
    ResolveError,
    Section,
    UnknownReferenceError,
)
from .resolver import resolve

__all__ = [
    "CycleError",
    "Document",
    "Entry",
    "Interp",
    "ParseError",
    "Ref",
    "ResolveError",
    "Section",
    "UnknownReferenceError",
    "dumps",
    "parse",
    "resolve",
]
