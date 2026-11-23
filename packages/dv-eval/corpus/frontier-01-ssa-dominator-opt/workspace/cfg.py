"""Grafo de fluxo de controle. Contrato em SPEC.md."""


def successors(f):
    raise NotImplementedError


def predecessors(f):
    raise NotImplementedError


def reachable(f):
    raise NotImplementedError


def rpo(f):
    raise NotImplementedError


def idoms(f):
    raise NotImplementedError


def dom_tree(f, idom):
    raise NotImplementedError


def dominates(idom, a, b):
    raise NotImplementedError


def dominance_frontier(f, idom):
    raise NotImplementedError
