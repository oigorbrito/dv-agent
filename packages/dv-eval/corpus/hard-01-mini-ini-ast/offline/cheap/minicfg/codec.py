"""Parser e serializador canônico do minicfg. Contrato em SPEC.md."""
import re

from .model import Document, Entry, Interp, ParseError, Ref, Section

_IDENT = r"[A-Za-z_][A-Za-z0-9_]*"
_SECTION = re.compile(rf"\[({_IDENT})\]")
_ENTRY = re.compile(rf"({_IDENT})\s*=\s*(.*)")
_REF_AT = re.compile(rf"\$\{{({_IDENT})\.({_IDENT})\}}")
_INT = re.compile(r"-?(0|[1-9][0-9]*)")
_FLOAT = re.compile(r"-?(0|[1-9][0-9]*)\.[0-9]+")
_ESCAPES = "\\\"$"


def parse(text):
    order = []
    current = None
    seen_sections = set()
    keys = set()
    for lineno, raw in enumerate(text.split("\n"), start=1):
        line = raw.strip()
        if line == "" or line.startswith("#"):
            continue
        header = _SECTION.fullmatch(line)
        if header is not None:
            name = header[1]
            if name in seen_sections:
                raise ParseError(lineno, f"seção repetida: {name}")
            seen_sections.add(name)
            current = (name, [])
            order.append(current)
            keys = set()
            continue
        entry = _ENTRY.fullmatch(line)
        if entry is None:
            raise ParseError(lineno, "linha inválida")
        if current is None:
            raise ParseError(lineno, "entrada antes de qualquer seção")
        key = entry[1]
        if key in keys:
            raise ParseError(lineno, f"chave repetida: {key}")
        keys.add(key)
        current[1].append(Entry(key, _parse_value(entry[2], lineno)))
    return Document(tuple(Section(name, tuple(entries)) for name, entries in order))


def _parse_value(text, lineno):
    if text == "true":
        return True
    if text == "false":
        return False
    if _INT.fullmatch(text):
        return int(text)
    if _FLOAT.fullmatch(text):
        return float(text)
    ref = _REF_AT.fullmatch(text)
    if ref is not None:
        return Ref(ref[1], ref[2])
    if text.startswith('"'):
        return _parse_quoted(text, lineno)
    raise ParseError(lineno, f"valor inválido: {text}")


def _parse_quoted(text, lineno):
    parts = []
    buf = []
    i = 1
    n = len(text)
    closed = False
    while i < n:
        ch = text[i]
        if ch == '"':
            closed = True
            i += 1
            break
        if ch == "\\":
            if i + 1 >= n or text[i + 1] not in _ESCAPES:
                raise ParseError(lineno, "escape inválido")
            buf.append(text[i + 1])
            i += 2
            continue
        if ch == "$" and text.startswith("${", i):
            ref = _REF_AT.match(text, i)
            if ref is None:
                raise ParseError(lineno, "referência inválida")
            if buf:
                parts.append("".join(buf))
                buf = []
            parts.append(Ref(ref[1], ref[2]))
            i = ref.end()
            continue
        buf.append(ch)
        i += 1
    if not closed:
        raise ParseError(lineno, "aspas não fechadas")
    if i != n:
        raise ParseError(lineno, "texto após o valor")
    if buf:
        parts.append("".join(buf))
    if all(isinstance(part, str) for part in parts):
        return "".join(parts)
    return Interp(tuple(parts))


def dumps(doc):
    blocks = []
    for section in doc.sections:
        lines = [f"[{section.name}]"]
        lines.extend(f"{entry.key} = {_render(entry.value)}" for entry in section.entries)
        blocks.append("\n".join(lines) + "\n")
    return "\n".join(blocks)


def _render(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return '"' + _escape(value) + '"'
    if isinstance(value, Ref):
        return _ref_text(value)
    if isinstance(value, Interp):
        body = "".join(_escape(p) if isinstance(p, str) else _ref_text(p) for p in value.parts)
        return '"' + body + '"'
    raise TypeError(f"valor não serializável: {value!r}")


def _escape(text):
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")


def _ref_text(ref):
    return f"${{{ref.section}.{ref.key}}}"
