"""Codec RLE. Contrato em SPEC.md."""

_DIGITS = "0123456789"
_MAX_COUNT = 1_000_000


def _emit(ch):
    return "\\" + ch if ch in _DIGITS or ch == "\\" else ch


def encode(text):
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        j = i
        while j < len(text) and text[j] == ch:
            j += 1
        count = j - i
        if count > 1:
            out.append(str(count))
        out.append(_emit(ch))
        i = j
    return "".join(out)


def decode(payload):
    out = []
    i = 0
    n = len(payload)
    while i < n:
        digits = ""
        while i < n and payload[i] in _DIGITS:
            digits += payload[i]
            i += 1
        if i >= n:
            if digits:
                raise ValueError("contagem sem caractere")
            break
        if payload[i] == "\\":
            if i + 1 >= n:
                raise ValueError("barra invertida sem caractere")
            ch = payload[i + 1]
            i += 2
        else:
            ch = payload[i]
            i += 1
        if digits:
            if digits[0] == "0" or int(digits) < 2 or int(digits) > _MAX_COUNT:
                raise ValueError(f"contagem inválida: {digits}")
            out.append(ch * int(digits))
        else:
            out.append(ch)
    return "".join(out)


def compression_ratio(text):
    if not text:
        return 1.0
    return round(len(encode(text)) / len(text), 4)
