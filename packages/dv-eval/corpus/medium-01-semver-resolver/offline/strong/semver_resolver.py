"""Resolvedor de restrições SemVer. Contrato em SPEC.md."""
import re
from collections import deque

_VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?")
_TERM = re.compile(r"(>=|<=|>|<|=|\^|~)?(.+)")


class InvalidVersion(ValueError):
    pass


class ResolutionConflict(Exception):
    def __init__(self, package, constraint, chosen=None, requester=None):
        self.package = package
        self.constraint = constraint
        self.chosen = chosen
        self.requester = requester
        super().__init__(f"conflito em {package}: restrição {constraint}")


def _parse(text):
    """(major, minor, patch, pre) com pre = tupla de identificadores (0, int) ou (1, str); () para release."""
    match = _VERSION.fullmatch(text)
    if match is None:
        raise InvalidVersion(text)
    major, minor, patch = int(match[1]), int(match[2]), int(match[3])
    pre = ()
    if match[4] is not None:
        pre = tuple((0, int(p)) if p.isdigit() else (1, p) for p in match[4].split("."))
    return (major, minor, patch, pre)


def _key(v):
    major, minor, patch, pre = v
    if not pre:
        return (major, minor, patch, 1, ())
    return (major, minor, patch, 0, pre)


def _expand(op, v):
    major, minor, patch, _ = v
    base = (major, minor, patch, ())
    if op == "^":
        if major > 0:
            upper = (major + 1, 0, 0, ())
        elif minor > 0:
            upper = (0, minor + 1, 0, ())
        else:
            upper = (0, 0, patch + 1, ())
        return [(">=", base), ("<", upper)]
    if op == "~":
        return [(">=", base), ("<", (major, minor + 1, 0, ()))]
    return [("=" if op == "=" else op, v)]


def _comparators(text):
    out = []
    for token in text.split():
        match = _TERM.fullmatch(token)
        op = match[1] or "="
        out.extend(_expand(op, _parse(match[2])))
    if not out:
        raise InvalidVersion(text)
    return out


def _holds(key, op, bound):
    b = _key(bound)
    return {
        ">=": key >= b,
        ">": key > b,
        "<": key < b,
        "<=": key <= b,
        "=": key == b,
    }[op]


def _set_satisfies(v, comparators):
    key = _key(v)
    if not all(_holds(key, op, bound) for op, bound in comparators):
        return False
    if v[3]:
        same_tuple_pre = any(bound[3] and bound[:3] == v[:3] for _, bound in comparators)
        if not same_tuple_pre:
            return False
    return True


def satisfies(version, constraint):
    v = _parse(version)
    return any(_set_satisfies(v, _comparators(part)) for part in constraint.split("||"))


def max_satisfying(versions, constraint):
    matches = [text for text in versions if satisfies(text, constraint)]
    if not matches:
        return None
    return max(matches, key=lambda text: _key(_parse(text)))


def resolve(root, registry):
    chosen = {}
    queue = deque((name, constraint, "<root>") for name, constraint in root.items())
    while queue:
        name, constraint, requester = queue.popleft()
        if name in chosen:
            if not satisfies(chosen[name], constraint):
                raise ResolutionConflict(name, constraint, chosen[name], requester)
            continue
        best = max_satisfying(registry.get(name, {}).keys(), constraint)
        if best is None:
            raise ResolutionConflict(name, constraint, None, requester)
        chosen[name] = best
        for dep, dep_constraint in registry[name][best].items():
            queue.append((dep, dep_constraint, f"{name}@{best}"))
    return chosen
