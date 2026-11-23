"""Unificação com registros de linha. Contrato em SPEC.md."""
from ast_types import TCon, TFun, TRec, TVar, fresh, pretty


class TypeErr(Exception):
    def __init__(self, message, origin=()):
        self.message = message
        self.origin = list(origin)
        suffix = f" [origem: {' > '.join(self.origin)}]" if self.origin else ""
        super().__init__(message + suffix)


class Subst:
    def __init__(self):
        self.map = {}

    def walk(self, t):
        while isinstance(t, TVar) and t.id in self.map:
            t = self.map[t.id]
        return t

    def resolve(self, t):
        t = self.walk(t)
        if isinstance(t, TFun):
            return TFun(self.resolve(t.arg), self.resolve(t.res))
        if isinstance(t, TRec):
            fields = {k: self.resolve(v) for k, v in t.fields.items()}
            row = self.walk(t.row) if t.row is not None else None
            if isinstance(row, TRec):
                inner = self.resolve(row)
                merged = dict(fields)
                merged.update(inner.fields)
                return TRec(merged, inner.row)
            return TRec(fields, row)
        return t


def _occurs(subst, v, t):
    t = subst.walk(t)
    if isinstance(t, TVar):
        return t.id == v.id
    if isinstance(t, TFun):
        return _occurs(subst, v, t.arg) or _occurs(subst, v, t.res)
    if isinstance(t, TRec):
        if any(_occurs(subst, v, x) for x in t.fields.values()):
            return True
        return t.row is not None and _occurs(subst, v, t.row)
    return False


def _bind(subst, v, t, origin):
    if _occurs(subst, v, t):
        raise TypeErr(f"ocorrência: {pretty(subst.resolve(v))} aparece em {pretty(subst.resolve(t))}", origin)
    subst.map[v.id] = t


def _unify_rows(subst, r1, r2, origin):
    if r1 is None and r2 is None:
        return
    if r1 is None:
        _bind(subst, r2, TRec({}, None), origin)
        return
    if r2 is None:
        _bind(subst, r1, TRec({}, None), origin)
        return
    if r1.id != r2.id:
        _bind(subst, r1, r2, origin)


def _unify_rec(subst, a, b, origin):
    ra, rb = subst.resolve(a), subst.resolve(b)
    fa, fb = ra.fields, rb.fields
    r1, r2 = ra.row, rb.row
    for k in fa.keys() & fb.keys():
        unify(subst, fa[k], fb[k], origin)
    only1 = {k: fa[k] for k in fa if k not in fb}
    only2 = {k: fb[k] for k in fb if k not in fa}
    if not only1 and not only2:
        _unify_rows(subst, r1, r2, origin)
        return
    if only1 and only2 and r1 is not None and r2 is not None and r1.id == r2.id:
        raise TypeErr("ocorrência de linha", origin)
    if only2 and r1 is None:
        raise TypeErr(f"campo ausente: {sorted(only2)[0]} em {pretty(ra)}", origin)
    if only1 and r2 is None:
        raise TypeErr(f"campo ausente: {sorted(only1)[0]} em {pretty(rb)}", origin)
    shared = fresh()
    if only2:
        _bind(subst, r1, TRec(only2, shared), origin)
    if only1:
        _bind(subst, r2, TRec(only1, shared), origin)
    if only2 and not only1:
        _unify_rows(subst, r2, shared, origin)
    if only1 and not only2:
        _unify_rows(subst, r1, shared, origin)


def unify(subst, a, b, origin=()):
    a, b = subst.walk(a), subst.walk(b)
    if isinstance(a, TVar) and isinstance(b, TVar) and a.id == b.id:
        return
    if isinstance(a, TVar):
        _bind(subst, a, b, origin)
        return
    if isinstance(b, TVar):
        _bind(subst, b, a, origin)
        return
    if isinstance(a, TCon) and isinstance(b, TCon):
        if a.name != b.name:
            raise TypeErr(f"não unifica {a.name} com {b.name}", origin)
        return
    if isinstance(a, TFun) and isinstance(b, TFun):
        unify(subst, a.arg, b.arg, origin)
        unify(subst, a.res, b.res, origin)
        return
    if isinstance(a, TRec) and isinstance(b, TRec):
        _unify_rec(subst, a, b, origin)
        return
    raise TypeErr(f"não unifica {pretty(subst.resolve(a))} com {pretty(subst.resolve(b))}", origin)
