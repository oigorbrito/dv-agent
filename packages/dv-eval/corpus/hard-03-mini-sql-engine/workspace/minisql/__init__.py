"""minisql: motor SQL em memória (subconjunto). Contrato em SPEC.md."""
from .planner import execute, explain
from .storage import Table
from .tokenizer import SQLError


class Result:
    def __init__(self, columns, rows):
        self.columns = list(columns)
        self.rows = list(rows)

    def __repr__(self):
        return f"Result(columns={self.columns!r}, rows={self.rows!r})"


class Database:
    def __init__(self):
        self._tables = {}

    def create_table(self, name, columns):
        if name in self._tables:
            raise SQLError(f"tabela já existe: {name}")
        self._tables[name] = Table(name, columns)

    def table(self, name):
        if name not in self._tables:
            raise SQLError(f"tabela desconhecida: {name}")
        return self._tables[name]

    def insert(self, name, row):
        self.table(name).insert(row)

    def create_index(self, name, column):
        self.table(name).create_index(column)

    def query(self, sql):
        columns, rows = execute(self, sql)
        return Result(columns, rows)

    def explain(self, sql):
        return explain(self, sql)


__all__ = ["Database", "Result", "SQLError", "Table"]
