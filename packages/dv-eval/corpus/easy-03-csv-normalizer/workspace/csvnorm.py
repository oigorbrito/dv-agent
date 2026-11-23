"""Normalizador CSV. Contrato em SPEC.md."""


def parse_csv(text, delimiter=","):
    raise NotImplementedError


def normalize(header, rows, key=None, types=None):
    raise NotImplementedError


def dump_csv(header, rows, delimiter=","):
    raise NotImplementedError
