# SPEC rle

Codec Run-Length Encoding sobre `str`.

## Formato
- Cada corrida de um mesmo caractere `c`, com `n` repetições:
  - se `n > 1`: escreve `n` em decimal e depois `c`;
  - se `n == 1`: escreve só `c`.
- Se `c` é um dígito (`0`-`9`) ou a barra invertida `\`, escreve `\` antes de `c`.
  Assim `"1"` vira `"\\1"` (duas posições: barra, dígito) e `"3333"` vira `"4\\3"`.
- Exemplos: `"aaabccdddd"` -> `"3ab2c4d"`; `"xxxxxxxxxxxx"` (12 x) -> `"12x"`; `""` -> `""`.

## encode(text: str) -> str
Aplica o formato acima.

## decode(payload: str) -> str
Inverso exato de `encode`. Levanta `ValueError` para payload corrompido:
- contagem sem caractere depois (ex.: `"3"`);
- barra invertida sem caractere depois (ex.: `"\\"`);
- contagem `0`, contagem `1` (nunca produzida por `encode`) ou contagem com zero à esquerda (ex.: `"02a"`);
- contagem maior que 1000000.

## compression_ratio(text: str) -> float
`len(encode(text)) / len(text)` arredondado para 4 casas. Texto vazio: `1.0`.

Módulo: `rle.py` na raiz do workspace. Não altere este arquivo.
