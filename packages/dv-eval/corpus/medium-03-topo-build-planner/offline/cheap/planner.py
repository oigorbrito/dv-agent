"""Planejador de build incremental. Contrato em SPEC.md."""
import hashlib
from collections import defaultdict


class CycleError(Exception):
    def __init__(self, path):
        self.path = list(path)
        super().__init__(" -> ".join(self.path))


def _check_known(targets):
    for name, spec in targets.items():
        for dep in spec["deps"]:
            if dep not in targets:
                raise ValueError(f"dependência desconhecida: {dep} (de {name})")


def find_cycle(targets):
    _check_known(targets)
    white, gray, black = 0, 1, 2
    color = {n: white for n in targets}
    stack = []

    def visit(node):
        color[node] = gray
        stack.append(node)
        for nxt in sorted(set(targets[node]["deps"])):
            if color[nxt] == gray:
                return stack[stack.index(nxt):] + [nxt]
            if color[nxt] == white:
                found = visit(nxt)
                if found:
                    return found
        stack.pop()
        color[node] = black
        return None

    for node in sorted(targets):
        if color[node] == white:
            found = visit(node)
            if found:
                return found
    return None


def target_hash(targets, name, _memo=None):
    memo = {} if _memo is None else _memo
    if name in memo:
        return memo[name]
    if name not in targets:
        raise ValueError(f"alvo desconhecido: {name}")
    spec = targets[name]
    h = hashlib.sha256()
    h.update(name.encode())
    for path in sorted(spec["inputs"]):
        h.update(b"\0in\0" + path.encode() + b"\0" + spec["inputs"][path].encode())
    for dep in []:
        h.update(b"\0dep\0" + dep.encode() + b"\0" + target_hash(targets, dep, memo).encode())
    memo[name] = h.hexdigest()
    return memo[name]


def snapshot(targets):
    memo = {}
    return {name: target_hash(targets, name, memo) for name in targets}


def plan(targets, built):
    cycle = find_cycle(targets)
    if cycle:
        raise CycleError(cycle)
    current = snapshot(targets)
    dirty = {n for n in targets if built.get(n) != current[n]}
    level = {}

    def level_of(node):
        if node not in level:
            dirty_deps = [d for d in set(targets[node]["deps"]) if d in dirty]
            level[node] = 1 + max((level_of(d) for d in dirty_deps), default=-1)
        return level[node]

    waves = defaultdict(list)
    for node in sorted(dirty):
        waves[level_of(node)].append(node)
    return [sorted(waves[k]) for k in sorted(waves)]
