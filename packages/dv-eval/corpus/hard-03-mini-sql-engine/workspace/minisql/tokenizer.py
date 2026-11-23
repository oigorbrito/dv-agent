"""Tokenizer do minisql. Contrato em SPEC.md."""


class SQLError(Exception):
    pass


def tokenize(sql):
    raise NotImplementedError
