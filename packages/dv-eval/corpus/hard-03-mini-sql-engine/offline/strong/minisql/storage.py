"""Armazenamento e índices hash. Contrato em SPEC.md."""
from .tokenizer import SQLError


class Table:
    def __init__(self, name, columns):
        if len(set(columns)) != len(columns):
            raise SQLError(f"coluna duplicada em {name}")
        self.name = name
        self.columns = list(columns)
        self.rows = []
        self._indexes = {}

    def _pos(self, column):
        if column not in self.columns:
            raise SQLError(f"coluna desconhecida: {column}")
        return self.columns.index(column)

    def insert(self, row):
        if len(row) != len(self.columns):
            raise SQLError("número de valores incompatível")
        tup = tuple(row)
        position = len(self.rows)
        self.rows.append(tup)
        for column, index in self._indexes.items():
            value = tup[self.columns.index(column)]
            if value is not None:
                index.setdefault(value, []).append(position)

    def create_index(self, column):
        pos = self._pos(column)
        index = {}
        for position, row in enumerate(self.rows):
            if row[pos] is not None:
                index.setdefault(row[pos], []).append(position)
        self._indexes[column] = index

    def has_index(self, column):
        return column in self._indexes

    def lookup(self, column, value):
        if value is None:
            return []
        return list(self._indexes[column].get(value, []))
