"""Nó Raft. Contrato em SPEC.md."""
from log import Log  # noqa: F401


class Node:
    def __init__(self, nid, peers):
        raise NotImplementedError
