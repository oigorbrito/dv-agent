"""Resolvedor de restrições SemVer. Contrato em SPEC.md."""


class InvalidVersion(ValueError):
    pass


class ResolutionConflict(Exception):
    def __init__(self, package, constraint, chosen=None, requester=None):
        self.package = package
        self.constraint = constraint
        self.chosen = chosen
        self.requester = requester
        super().__init__(f"conflito em {package}: restrição {constraint}")


def satisfies(version, constraint):
    raise NotImplementedError


def max_satisfying(versions, constraint):
    raise NotImplementedError


def resolve(root, registry):
    raise NotImplementedError
