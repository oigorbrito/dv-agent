"""Compilador do vmgc. Contrato em SPEC.md."""


class CompileError(Exception):
    def __init__(self, message, line):
        self.line = line
        super().__init__(f"linha {line}: {message}")


class Function:
    def __init__(self, name, code, lines, nparams, nlocals):
        self.name = name
        self.code = code
        self.lines = lines
        self.nparams = nparams
        self.nlocals = nlocals


class Program:
    def __init__(self, functions):
        self.functions = functions


def compile_source(src):
    raise NotImplementedError
