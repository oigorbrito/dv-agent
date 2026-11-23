# SPEC logparse

Formato de cada linha: `<timestamp> <NIVEL> <mensagem>`

- `timestamp`: ISO 8601 estendido com data, hora e deslocamento obrigatório (`Z` ou `±HH:MM`). Fração de segundo é opcional. Timestamp sem deslocamento é inválido.
- `NIVEL`: exatamente um de `DEBUG`, `INFO`, `WARN`, `ERROR` (maiúsculas). Qualquer outro valor é inválido.
- `mensagem`: texto restante após o nível (pode conter espaços). Ausente é inválido.
- Espaços no início e no fim da linha são ignorados.

## parse_line(line: str) -> dict | None

- Linha válida: retorna `{"ts": datetime, "level": str, "message": str}`. `ts` é aware e normalizado para UTC.
- Linha inválida (qualquer violação acima): retorna `None`.

## summarize(lines: Iterable[str]) -> dict

- Linhas em branco (só espaços) são ignoradas: não contam em `total` nem em `malformed`.
- Linhas não-branco inválidas contam em `malformed`.
- Retorna um dict com:
  - `total`: número de linhas válidas;
  - `malformed`: número de linhas inválidas;
  - `by_level`: dict com as quatro chaves sempre presentes (inclusive com 0);
  - `first` / `last`: menor e maior `ts` (UTC) entre as válidas, ou `None` se não houver nenhuma;
  - `duration_s`: `(last - first)` em segundos (float); `0.0` se não houver linhas válidas;
  - `error_rate`: `by_level["ERROR"] / total` arredondado a 4 casas; `0.0` se `total == 0`.

Módulo: `logparse.py` na raiz do workspace. Não altere este arquivo.
