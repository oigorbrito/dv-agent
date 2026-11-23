"""Normalizador CSV. Contrato em SPEC.md."""

NULL_TOKENS = {"", "NULL", "null", "N/A"}
_BOOL = {"true": True, "yes": True, "false": False, "no": False}


def parse_csv(text, delimiter=","):
    rows = []
    row = []
    field = []
    in_quotes = False
    has_content = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 2
                    continue
                in_quotes = False
            else:
                field.append(ch)
            i += 1
            continue
        if ch == '"' and not field:
            in_quotes = True
            has_content = True
            i += 1
            continue
        if ch == delimiter:
            row.append("".join(field))
            field = []
            has_content = True
            i += 1
            continue
        if ch in "\r\n":
            if ch == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1
            if has_content or field or row:
                row.append("".join(field))
                rows.append(row)
            row = []
            field = []
            has_content = False
            i += 1
            continue
        field.append(ch)
        has_content = True
        i += 1
    if in_quotes:
        raise ValueError("aspas não fechadas")
    if has_content or field or row:
        row.append("".join(field))
        rows.append(row)
    return rows


def _norm_header(name):
    return "_".join(name.strip().lower().split())


def _cast(value, kind):
    if value is None or kind is None:
        return value
    if kind == "int":
        return int(value)
    if kind == "float":
        return float(value)
    if kind == "bool":
        low = value.lower()
        if low not in _BOOL:
            raise ValueError(f"booleano inválido: {value!r}")
        return _BOOL[low]
    raise ValueError(f"tipo desconhecido: {kind}")


def normalize(header, rows, key=None, types=None):
    cols = [_norm_header(h) for h in header]
    if len(set(cols)) != len(cols):
        raise ValueError("cabeçalho duplicado após normalização")
    types = types or {}
    if set(types) - set(cols):
        raise ValueError("tipo declarado para coluna inexistente")
    if key is not None and key not in cols:
        raise ValueError("chave inexistente")
    cleaned = []
    for raw in rows:
        if len(raw) != len(cols):
            raise ValueError("número de células diferente do cabeçalho")
        values = []
        for col, cell in zip(cols, raw):
            text = cell.strip()
            value = None if text in NULL_TOKENS else text
            values.append(_cast(value, types.get(col)))
        cleaned.append(values)
    if key is None:
        return cols, cleaned
    k_idx = cols.index(key)
    order = []
    latest = {}
    for values in cleaned:
        k = values[k_idx]
        if k is None:
            raise ValueError("chave primária nula")
        if k not in latest:
            order.append(k)
        latest[k] = values
    return cols, [latest[k] for k in order]


def _cell(value, delimiter):
    if value is None:
        return ""
    if isinstance(value, bool):
        text = "true" if value else "false"
    else:
        text = str(value)
    if any(c in text for c in (delimiter, '"', "\r", "\n")):
        return '"' + text.replace('"', '""') + '"'
    return text


def dump_csv(header, rows, delimiter=","):
    lines = [delimiter.join(_cell(h, delimiter) for h in header)]
    for row in rows:
        lines.append(delimiter.join(_cell(v, delimiter) for v in row))
    return "\n".join(lines) + "\n"
