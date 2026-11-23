"""Planejador e executor do minisql. Contrato em SPEC.md."""
from .parser import parse
from .tokenizer import SQLError


class _Source:
    def __init__(self, alias, table, offset):
        self.alias = alias
        self.table = table
        self.offset = offset


def _text(ref):
    return f"{ref[1]}.{ref[2]}" if ref[1] is not None else ref[2]


def _sources(db, parsed):
    base = db.table(parsed["table"])
    sources = [_Source(parsed["alias"] or base.name, base, 0)]
    if parsed["join"] is not None:
        j = parsed["join"]
        table = db.table(j["table"])
        sources.append(_Source(j["alias"] or table.name, table, len(base.columns)))
    aliases = [s.alias for s in sources]
    if len(set(aliases)) != len(aliases):
        raise SQLError("alias duplicado")
    return sources


def _resolve(ref, sources):
    matches = []
    for src in sources:
        if ref[1] is not None and ref[1] != src.alias:
            continue
        if ref[2] in src.table.columns:
            matches.append(src.offset + src.table.columns.index(ref[2]))
    if not matches:
        raise SQLError(f"coluna desconhecida: {_text(ref)}")
    if len(matches) > 1:
        raise SQLError(f"coluna ambígua: {_text(ref)}")
    return matches[0]


def _truth(value):
    return value is True


def _compare(op, a, b):
    if a is None or b is None:
        return False
    if type(a) is not type(b):
        raise SQLError("tipos incomparáveis")
    return {"=": a == b, "!=": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


def _has_agg(expr):
    kind = expr[0]
    if kind == "agg":
        return True
    if kind == "cmp":
        return _has_agg(expr[2]) or _has_agg(expr[3])
    if kind in ("and", "or"):
        return _has_agg(expr[1]) or _has_agg(expr[2])
    return False


def _eval(expr, env, sources):
    kind = expr[0]
    if kind == "lit":
        return expr[1]
    if kind == "col":
        return env[_resolve(expr, sources)]
    if kind == "agg":
        raise SQLError("agregação fora de contexto de agrupamento")
    if kind == "cmp":
        return _compare(expr[1], _eval(expr[2], env, sources), _eval(expr[3], env, sources))
    if kind == "and":
        return _truth(_eval(expr[1], env, sources)) and _truth(_eval(expr[2], env, sources))
    if kind == "or":
        return _truth(_eval(expr[1], env, sources)) or _truth(_eval(expr[2], env, sources))
    raise SQLError(f"expressão inválida: {kind}")


def _conjuncts(expr):
    if expr is None:
        return []
    if expr[0] == "and":
        return _conjuncts(expr[1]) + _conjuncts(expr[2])
    return [expr]


def _same_type(table, pos, literal):
    types = {type(row[pos]) for row in table.rows if row[pos] is not None}
    return types <= {type(literal)}


def _base_rows(parsed, base):
    if parsed["join"] is None:
        base_alias = parsed["alias"] or base.name
        for conj in _conjuncts(parsed["where"]):
            if conj[0] != "cmp" or conj[1] != "=":
                continue
            for ref, lit in ((conj[2], conj[3]), (conj[3], conj[2])):
                if ref[0] != "col" or lit[0] != "lit" or lit[1] is None:
                    continue
                if ref[1] not in (None, base_alias) or ref[2] not in base.columns:
                    continue
                pos = base.columns.index(ref[2])
                if base.has_index(ref[2]) and _same_type(base, pos, lit[1]):
                    rows = [base.rows[p] for p in base.lookup(ref[2], lit[1])]
                    return rows, f"INDEX_LOOKUP {base.name}.{ref[2]}"
    return list(base.rows), f"SEQ_SCAN {base.name}"


def _joined_envs(parsed, sources, base_rows):
    if parsed["join"] is None:
        return list(base_rows)
    join = parsed["join"]
    right = sources[1].table
    envs = []
    for left in base_rows:
        matched = False
        for rrow in right.rows:
            env = left + rrow
            if _truth(_eval(join["on"], env, sources)):
                envs.append(env)
                matched = True
        if not matched and join["kind"] == "LEFT":
            envs.append(left + (None,) * len(right.columns))
    return envs


def _is_grouped(parsed):
    if parsed["group"] or parsed["having"] is not None:
        return True
    return any(expr[0] != "star" and _has_agg(expr) for expr, _ in parsed["items"])


def _out_name(expr, alias):
    if alias is not None:
        return alias
    if expr[0] == "col":
        return _text(expr)
    if expr[0] == "agg":
        return f"{expr[1]}({'*' if expr[2] is None else _text(expr[2])})"
    if expr[0] == "lit":
        return "NULL" if expr[1] is None else str(expr[1])
    return "?"


def _aggregate(expr, members, sources):
    _, func, arg = expr
    if arg is None:
        return len(members)
    pos = _resolve(arg, sources)
    values = [env[pos] for env in members if env[pos] is not None]
    if func == "COUNT":
        return len(values)
    if func in ("SUM", "AVG"):
        if any(not isinstance(v, int) or isinstance(v, bool) for v in values):
            raise SQLError(f"{func} exige inteiros")
        if not values:
            return None
        total = sum(values)
        return total if func == "SUM" else total / len(values)
    if not values:
        return None
    return min(values) if func == "MIN" else max(values)


def _group_eval(expr, members, sources, group_pos, key):
    kind = expr[0]
    if kind == "lit":
        return expr[1]
    if kind == "col":
        pos = _resolve(expr, sources)
        if pos not in group_pos:
            raise SQLError(f"coluna não agregada: {_text(expr)}")
        return key[group_pos.index(pos)]
    if kind == "agg":
        return _aggregate(expr, members, sources)
    if kind == "cmp":
        return _compare(
            expr[1],
            _group_eval(expr[2], members, sources, group_pos, key),
            _group_eval(expr[3], members, sources, group_pos, key),
        )
    if kind == "and":
        return _truth(_group_eval(expr[1], members, sources, group_pos, key)) and _truth(
            _group_eval(expr[2], members, sources, group_pos, key))
    if kind == "or":
        return _truth(_group_eval(expr[1], members, sources, group_pos, key)) or _truth(
            _group_eval(expr[2], members, sources, group_pos, key))
    raise SQLError(f"expressão inválida em agregação: {kind}")


def _grouped(parsed, sources, envs):
    if any(expr[0] == "star" for expr, _ in parsed["items"]):
        raise SQLError("* não pode aparecer em agregação")
    group_pos = [_resolve(c, sources) for c in parsed["group"]]
    groups = {}
    order = []
    for env in envs:
        key = tuple(env[p] for p in group_pos)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(env)
    if not group_pos and not order:
        groups[()] = []
        order.append(())
    rows = []
    for key in order:
        members = groups[key]
        if parsed["having"] is not None and not _truth(
            _group_eval(parsed["having"], members, sources, group_pos, key)
        ):
            continue
        rows.append(
            tuple(_group_eval(expr, members, sources, group_pos, key) for expr, _ in parsed["items"])
        )
    columns = [_out_name(expr, alias) for expr, alias in parsed["items"]]
    exprs = [expr for expr, _ in parsed["items"]]
    return columns, exprs, rows


def _projected(parsed, sources, envs):
    columns, exprs, plan = [], [], []
    for expr, alias in parsed["items"]:
        if expr[0] == "star":
            for src in sources:
                for col in src.table.columns:
                    name = f"{src.alias}.{col}" if len(sources) > 1 else col
                    columns.append(name)
                    exprs.append(("col", src.alias, col))
                    plan.append(("pos", src.offset + src.table.columns.index(col)))
        else:
            columns.append(_out_name(expr, alias))
            exprs.append(expr)
            plan.append(("expr", expr))
    rows = []
    for env in envs:
        row = []
        for kind, payload in plan:
            row.append(env[payload] if kind == "pos" else _eval(payload, env, sources))
        rows.append(tuple(row))
    return columns, exprs, rows


def _order_index(op, columns, exprs):
    for index, expr in enumerate(exprs):
        if expr == op:
            return index
    if op[0] == "col" and op[1] is None and op[2] in columns:
        return columns.index(op[2])
    raise SQLError(f"ORDER BY fora da seleção: {_text(op) if op[0] == 'col' else op[0]}")


def _sort_nulls_last(rows, index, desc):
    present = [r for r in rows if r[index] is not None]
    absent = [r for r in rows if r[index] is None]
    try:
        present.sort(key=lambda r: r[index], reverse=desc)
    except TypeError as exc:
        raise SQLError("valores incomparáveis em ORDER BY") from exc
    return present + absent


def _order(parsed, columns, exprs, rows):
    for op, desc in reversed(parsed["order"]):
        rows = _sort_nulls_last(rows, _order_index(op, columns, exprs), desc)
    return rows


def execute(db, sql):
    parsed = parse(sql)
    sources = _sources(db, parsed)
    base_rows, _ = _base_rows(parsed, sources[0].table)
    envs = _joined_envs(parsed, sources, base_rows)
    if parsed["where"] is not None:
        envs = [e for e in envs if _truth(_eval(parsed["where"], e, sources))]
    if _is_grouped(parsed):
        columns, exprs, rows = _grouped(parsed, sources, envs)
    else:
        columns, exprs, rows = _projected(parsed, sources, envs)
    rows = _order(parsed, columns, exprs, rows)
    return columns, rows


def explain(db, sql):
    parsed = parse(sql)
    sources = _sources(db, parsed)
    _, first = _base_rows(parsed, sources[0].table)
    steps = [first]
    if parsed["join"] is not None:
        steps.append(f"NESTED_LOOP_{parsed['join']['kind']}_JOIN {parsed['join']['table']}")
    if parsed["where"] is not None:
        steps.append("FILTER")
    if _is_grouped(parsed):
        steps.append("GROUP_AGGREGATE")
    if parsed["order"]:
        steps.append("SORT")
    return steps
