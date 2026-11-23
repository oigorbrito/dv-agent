"""Máquina virtual de pilha. Contrato em SPEC.md."""


class VMError(Exception):
    def __init__(self, message, trace):
        self.trace = list(trace)
        super().__init__(message)


class VM:
    def __init__(self, program, threshold=8):
        raise NotImplementedError

    def run(self):
        raise NotImplementedError

    def to_python(self, value):
        raise NotImplementedError
