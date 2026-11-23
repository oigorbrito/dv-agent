"""Planejador de build incremental. Contrato em SPEC.md."""


class CycleError(Exception):
    def __init__(self, path):
        self.path = list(path)
        super().__init__(" -> ".join(self.path))


def find_cycle(targets):
    raise NotImplementedError


def target_hash(targets, name):
    raise NotImplementedError


def snapshot(targets):
    raise NotImplementedError


def plan(targets, built):
    raise NotImplementedError
