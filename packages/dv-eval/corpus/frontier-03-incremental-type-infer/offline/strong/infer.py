"""Algorithm W. Contrato em SPEC.md."""
from ast_types import BOOL, INT, Scheme, TFun, TRec, TVar, fresh, pretty
from unify import Subst, TypeErr, unify


def _collect(subst, t, out):
    t = subst.resolve(t)
    if isinstance(t, TVar):
        out[t.id] = t
    elif isinstance(t, TFun):
        _collect(subst, t.arg, out)
        _collect(subst, t.res, out)
    elif isinstance(t, TRec):
        for v in t.fields.values():
            _collect(subst, v, out)
        if t.row is not None:
            _collect(subst, t.row, out)
    return out


def _instantiate(scheme, subst):
    mapping = {v.id: fresh() for v in scheme.vars}

    def inst(t):
        if isinstance(t, TVar):
            return mapping.get(t.id, t)
        if isinstance(t, TFun):
            return TFun(inst(t.arg), inst(t.res))
        if isinstance(t, TRec):
            return TRec({k: inst(v) for k, v in t.fields.items()}, inst(t.row) if t.row is not None else None)
        return t

    return inst(subst.resolve(scheme.type))


def _generalize(subst, t, env):
    env_vars = {}
    for sch in env.values():
        bound = {v.id for v in sch.vars}
        for vid, v in _collect(subst, sch.type, {}).items():
            if vid not in bound:
                env_vars[vid] = v
    free = _collect(subst, t, {})
    quantified = [v for vid, v in free.items() if vid not in env_vars]
    return Scheme(quantified, subst.resolve(t))


def _w(expr, env, subst, ctx):
    kind = expr[0]
    if kind == "var":
        if expr[1] not in env:
            raise TypeErr(f"variável não definida: {expr[1]}", ctx)
        return _instantiate(env[expr[1]], subst)
    if kind == "lit":
        return INT
    if kind == "bool":
        return BOOL
    if kind == "lam":
        tv = fresh()
        env2 = dict(env)
        env2[expr[1]] = Scheme([], tv)
        return TFun(tv, _w(expr[2], env2, subst, ctx + (f"lam {expr[1]}",)))
    if kind == "app":
        tf = _w(expr[1], env, subst, ctx)
        ta = _w(expr[2], env, subst, ctx)
        tr = fresh()
        unify(subst, tf, TFun(ta, tr), ctx + ("aplicação",))
        return tr
    if kind == "let":
        tv = _w(expr[2], env, subst, ctx + (f"let {expr[1]}",))
        env2 = dict(env)
        env2[expr[1]] = _generalize(subst, tv, env)
        return _w(expr[3], env2, subst, ctx)
    if kind == "if":
        tc = _w(expr[1], env, subst, ctx)
        unify(subst, tc, BOOL, ctx + ("condição de if",))
        t1 = _w(expr[2], env, subst, ctx)
        t2 = _w(expr[3], env, subst, ctx)
        unify(subst, t1, t2, ctx + ("ramos de if",))
        return t1
    if kind == "rec":
        return TRec({k: _w(v, env, subst, ctx) for k, v in expr[1].items()}, None)
    if kind == "proj":
        t = _w(expr[1], env, subst, ctx)
        r = fresh()
        unify(subst, t, TRec({expr[2]: r}, fresh()), ctx + (f"acesso .{expr[2]}",))
        return r
    raise ValueError(f"expressão desconhecida: {kind}")


def infer(expr):
    subst = Subst()
    t = _w(expr, {}, subst, ())
    return pretty(subst.resolve(t))
