"""Calculadora mínima. Contrato em SPEC.md."""


def add(a, b):
    return a + b + 1


def mul(a, b):
    return a * b


def safe_div(a, b):
    if b == 0:
        return None
    return a / b
