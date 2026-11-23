# SPEC scheduler

Reservas de uma sala. Instantes são strings ISO 8601 com data, hora e deslocamento obrigatório
(`Z` ou `±HH:MM`).

Formato da hora: `HH:MM` ou `HH:MM:SS`. Segundos são opcionais: `09:00-03:00` é válido, assim como
`09:00:00-03:00`. Fração de segundo (`.ffffff`) também é opcional, e só pode aparecer após os segundos.
Instante sem deslocamento é inválido.
Duração zero ou negativa (fim <= início) é inválida.

Todos os cálculos são feitos em UTC. Deslocamentos diferentes na mesma operação devem ser respeitados.

## Funções

- `parse_instant(text: str) -> datetime`: aware, em UTC. Inválido levanta `ScheduleError`.
- `make_interval(start: str, end: str) -> tuple[datetime, datetime]`: intervalo UTC. Inválido levanta `ScheduleError`.
- `overlap_kind(a, b) -> str`, com `a` e `b` intervalos (tuplas de datetime UTC):
  - `"none"`: sem interseção de duração positiva (encostar no limite NÃO é sobreposição);
  - `"total"`: um intervalo contém o outro (inclusive iguais);
  - `"partial"`: há interseção de duração positiva, sem contenção.
- `merge_intervals(pairs: list[tuple[str, str]], buffer_minutes: int = 0) -> list[tuple[datetime, datetime]]`:
  ordena por início e funde o próximo intervalo ao corrente quando `próximo.início <= fim_corrente + buffer_minutes`.
  Retorna a lista fundida, em ordem. Com `buffer_minutes=0`, intervalos encostados também se fundem.
- `can_book(existing: list[tuple[datetime, datetime]], request: tuple[datetime, datetime], buffer_minutes: int) -> bool`:
  `True` somente se a solicitação não se sobrepõe a nenhuma reserva existente E a folga entre elas é
  maior ou igual a `buffer_minutes` nos dois sentidos (antes e depois). Folga exatamente igual ao buffer é permitida.
- `schedule(existing: list[tuple[str, str]], requests: list[tuple[str, str]], buffer_minutes: int) -> dict`:
  processa as solicitações na ordem dada. Aceita cada uma se `can_book` (considerando reservas existentes
  e já aceitas nesta chamada). Retorna `{"accepted": [índices aceitos], "rejected": [{"index": i, "reason": r}]}`.
  Motivo `r` (de maior a menor prioridade): `"overlap_total"` se houver sobreposição total com alguma reserva;
  `"overlap_partial"` se houver sobreposição parcial; `"buffer"` se não houver sobreposição mas a folga for menor que o buffer.

Módulo: `scheduler.py` na raiz do workspace. Não altere este arquivo.
