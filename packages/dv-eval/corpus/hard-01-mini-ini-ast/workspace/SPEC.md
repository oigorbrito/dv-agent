# SPEC minicfg

Pacote `minicfg` com três módulos interdependentes:
- `model.py` (pronto; contém os tipos e as exceções): não altere.
- `codec.py` (a implementar): `parse(text) -> Document` e `dumps(doc) -> str`. Depende de `model.py`.
- `resolver.py` (a implementar): `resolve(doc) -> dict`. Depende de `model.py`.
- `__init__.py` (pronto): reexporta tudo. Não altere.

## Sintaxe
- Linhas em branco e linhas cujo primeiro caractere não-branco é `#` são ignoradas.
- Seção: `[nome]`. Nome e chave seguem `[A-Za-z_][A-Za-z0-9_]*`.
- Entrada: `chave = valor`, uma por linha. Entrada antes de qualquer seção é erro.
- Nome de seção repetido, ou chave repetida na mesma seção, é erro.
- Qualquer linha que não seja comentário, seção ou entrada válida é erro.
- Erros de sintaxe levantam `ParseError(line, message)` com o número da linha (1-based).

## Valores
- `true` / `false` → `bool`.
- Inteiro decimal com sinal opcional, sem zeros à esquerda (`-?(0|[1-9][0-9]*)`) → `int`.
- Decimal com parte fracionária obrigatória (`-?(0|[1-9][0-9]*)\.[0-9]+`) → `float`.
- `${secao.chave}` sem aspas → `Ref` (no resolver, assume o tipo do valor referenciado).
- Texto entre aspas duplas → `str`. Escapes válidos dentro das aspas: `\\`, `\"` e `\$`; outro escape é erro.
  Dentro das aspas, `${secao.chave}` é referência; então o valor vira `Interp` (partes literais `str` não vazias e `Ref`).
  Aspas sem referência resultam em `str`, mesmo que o conteúdo pareça número ou booleano.
- Qualquer outro valor, ou texto depois do valor, é erro.
- O parser produz forma canônica: partes literais adjacentes são unidas e nunca há parte literal vazia.

## codec.py
- `dumps(doc)`: forma canônica. Cada seção vira `[nome]` seguido de `chave = valor` por linha. Seções são separadas
  por uma linha em branco. A saída termina com `\n`. Comentários não são preservados.
  - `bool` → `true`/`false`; `int` → decimal; `float` → `repr(x)` (ex.: `2.0`, nunca sem ponto decimal);
  - `str` → aspas duplas, escapando `\` como `\\`, `"` como `\"` e `$` como `\$`;
  - `Interp` → aspas duplas, partes literais escapadas e `${secao.chave}` nas referências;
  - `Ref` → `${secao.chave}` sem aspas.
- Round-trip: para todo `d = parse(t)`, `parse(dumps(d)) == d` e `dumps(parse(dumps(d))) == dumps(d)`.

## resolver.py
- `resolve(doc) -> dict[str, dict[str, bool | int | float | str]]`: seção → chave → valor final tipado.
- `Ref` sem aspas: valor final do alvo, com o mesmo tipo.
- `Interp`: concatena as partes; cada referência entra como texto: `bool` → `true`/`false`; `int` → decimal;
  `float` → `repr`; `str` → o próprio texto.
- Referência a seção ou chave inexistente → `UnknownReferenceError`.
- Ciclo de referências (direto, indireto ou auto-referência) → `CycleError`. O atributo `path` é a lista de
  `(secao, chave)` do ciclo, começando e terminando no nó repetido. Ex.: `a.x -> b.y -> a.x` gera
  `[("a","x"),("b","y"),("a","x")]`.

Não altere SPEC.md.
