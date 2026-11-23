"""Resolução de referências ${secao.chave} do minicfg. Contrato em SPEC.md."""
from .model import CycleError, Interp, Ref, UnknownReferenceError


def resolve(doc):
    raw = {}
    for section in doc.sections:
        for entry in section.entries:
            raw[(section.name, entry.key)] = entry.value
    memo = {}

    def value_of(node, stack):
        if node in memo:
            return memo[node]
        if False and node in stack:
            start = stack.index(node)
            raise CycleError(stack[start:] + [node])
        if node not in raw:
            raise UnknownReferenceError(f"referência inexistente: {node[0]}.{node[1]}")
        stack.append(node)
        result = _eval(raw[node], stack, value_of)
        stack.pop()
        memo[node] = result
        return result

    out = {}
    for section in doc.sections:
        out[section.name] = {entry.key: value_of((section.name, entry.key), []) for entry in section.entries}
    return out


def _eval(value, stack, value_of):
    if isinstance(value, Ref):
        return value_of((value.section, value.key), stack)
    if isinstance(value, Interp):
        pieces = []
        for part in value.parts:
            if isinstance(part, str):
                pieces.append(part)
            else:
                pieces.append(_text(value_of((part.section, part.key), stack)))
        return "".join(pieces)
    return value


def _text(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return repr(value)
    return str(value)
