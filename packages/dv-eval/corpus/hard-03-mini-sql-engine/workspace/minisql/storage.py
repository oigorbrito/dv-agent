"""Armazenamento e índices hash. Contrato em SPEC.md."""


class Table:
    def __init__(self, name, columns):
        raise NotImplementedError

    def insert(self, row):
        raise NotImplementedError

    def create_index(self, column):
        raise NotImplementedError

    def has_index(self, column):
        raise NotImplementedError

    def lookup(self, column, value):
        raise NotImplementedError
