"""Slugs ASCII determinísticos. Contrato em SPEC.md."""
import re
import unicodedata

_EXTRA = {
    "ß": "ss", "æ": "ae", "Æ": "AE", "ø": "o", "Ø": "O",
    "đ": "d", "Đ": "D", "ł": "l", "Ł": "L",
}


def _transliterate(text):
    out = []
    for ch in text:
        if ch in _EXTRA:
            out.append(_EXTRA[ch])
            continue
        decomposed = unicodedata.normalize("NFKD", ch)
        out.append("".join(c for c in decomposed if not unicodedata.combining(c)))
    return "".join(out)


def _fit(slug, limit):
    if len(slug) <= limit:
        return slug
    if slug[limit] == "-":
        return slug[:limit]
    cut = slug[:limit]
    k = cut.rfind("-")
    if k > 0:
        return cut[:k]
    return cut.rstrip("-")


def make_slug(title, max_len=40):
    if max_len < 1:
        raise ValueError("max_len deve ser >= 1")
    base = re.sub(r"[^a-z0-9]+", "-", _transliterate(title).lower()).strip("-")
    return _fit(base, max_len) or "item"


class Slugger:
    def __init__(self, reserved=(), max_len=40):
        self.max_len = max_len
        self._used = set(reserved)

    def assign(self, title):
        base = make_slug(title, self.max_len)
        candidate = base
        n = 2
        while candidate in self._used:
            suffix = f"-{n}"
            candidate = _fit(base, self.max_len - len(suffix)) + suffix
            n += 1
        self._used.add(candidate)
        return candidate
