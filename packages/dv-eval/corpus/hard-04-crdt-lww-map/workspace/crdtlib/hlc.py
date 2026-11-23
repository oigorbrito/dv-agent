"""Relógio híbrido (HLC). Contrato em SPEC.md."""


class HLC:
    def __init__(self, replica):
        raise NotImplementedError

    def now(self, physical):
        raise NotImplementedError

    def observe(self, remote, physical):
        raise NotImplementedError
