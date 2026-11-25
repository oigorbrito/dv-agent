"""Leitor minimalista de arquivos de configuração no formato chave = valor, com seções [nome]."""


def parse_config(text):
    result = {}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            result.setdefault(section, {})
            continue
        if "=" not in line:
            raise ValueError(f"linha inválida: {raw!r}")
        key, value = line.split("=")
        target = result if section is None else result.setdefault(section, {})
        target[key.strip()] = value.strip()
    return result
