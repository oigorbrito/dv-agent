# SPEC limiter

`RateLimiter(clock)`: `clock()` devolve o tempo atual em milissegundos inteiros. Nunca dorme.

## configure(route, limit, window_ms, sub_windows=4, burst=0)
- `limit` >= 1, `window_ms` >= 1, `sub_windows` >= 1, `burst` >= 0 (senão `ValueError`).
- `window_ms` deve ser múltiplo de `sub_windows` (senão `ValueError`). Largura da sub-janela: `width = window_ms // sub_windows`.

## Janela deslizante (por rota e por tenant)
- Cada requisição aceita é contada no bucket de início `s = now - now % width`.
- Um bucket com início `s` conta na janela enquanto `s + window_ms > now`. Quando `now >= s + window_ms`, sai.
- Janela cheia: contagem total dos buckets vivos `>= limit`.

## Token bucket (burst), opcional
- Ativo se `burst > 0`. Capacidade `burst` tokens, começa cheio, recarrega de forma contínua a `limit / window_ms` tokens por ms,
  sem passar da capacidade. Aritmética exata (use `fractions.Fraction`).
- Requisição precisa de 1 token disponível (`>= 1`).

## allow(tenant, route) -> tuple[bool, int]
- Rota não configurada: `ValueError`.
- Permite se a janela não está cheia **e** (o bucket está desativado ou tem `>= 1` token). Ao permitir, conta na janela
  e consome 1 token se o bucket está ativo. Retorna `(True, 0)`.
- Nega caso contrário, sem consumir nada, e retorna `(False, retry_after_ms)`, onde:
  - `retry_after_ms` por janela cheia: o menor tempo até a contagem cair abaixo de `limit`; isto é,
    remover os buckets mais antigos, em ordem, até a contagem ficar `< limit`, e o retry é `s_último_removido + window_ms - now`.
  - `retry_after_ms` por token: `ceil((1 - tokens) * window_ms / limit)`.
  - Se ambos bloqueiam, o maior dos dois.
- Estado é independente por `(tenant, route)`.

Módulo: `limiter.py` na raiz do workspace. Não altere este arquivo.
