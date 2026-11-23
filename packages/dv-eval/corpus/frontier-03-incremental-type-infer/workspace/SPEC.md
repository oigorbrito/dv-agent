# SPEC hmtypes

Três módulos planos: `ast_types.py` (sem dependências), `unify.py` (usa `ast_types`) e `infer.py` (usa os dois).

## Expressões (tuplas)
- `("var", nome)`, `("lit", inteiro)`, `("bool", True|False)`
- `("lam", parâmetro, corpo)`, `("app", função, argumento)`
- `("let", nome, valor, corpo)`: `let` polimórfico (generalização do valor).
- `("if", condição, então, senão)`
- `("rec", {campo: expr})`: registro **fechado**, com exatamente esses campos.
- `("proj", expr, campo)`: acesso `expr.campo`.

## ast_types.py
- `TVar()`: variável de tipo fresca; atributo `id` (inteiro crescente). Também serve como variável de linha.
- `TCon(nome)`: `INT = TCon("int")`, `BOOL = TCon("bool")`.
- `TFun(arg, res)`.
- `TRec(fields: dict, row)`: `row` é `None` (registro fechado) ou um `TVar` (linha aberta).
- `Scheme(vars: list[TVar], type)`: tipo quantificado sobre `vars`.
- `fresh() -> TVar()`.
- `pretty(t) -> str`: forma canônica. Variáveis (de tipo ou de linha) são nomeadas `a`, `b`, `c`... pela **ordem de primeira aparição** na impressão. Registro: campos em ordem alfabética, `{x: int, y: bool}`; aberto: `{x: a | b}` (com a linha depois de ` | `); sem campos e aberto: `{| b}`. Função: `a -> b`, com parênteses quando o argumento é função. Associação à direita. Sem `resolve`: receber já o tipo resolvido.

## unify.py
- `TypeErr(message, origin)`: `.message` e `.origin` (lista de strings do contexto, de fora para dentro). `str()` concatena `message` e `[origem: ...]` se houver origem.
- `Subst()`: `map` (id -> tipo). `walk(t)`: segue ligações só na cabeça. `resolve(t)`: aplica a substituição recursivamente. Linha ligada a um `TRec` é **achatada** no registro: os campos dela são somados e a linha vira a linha dela.
- `unify(subst, a, b, origin=())`:
  - Variável: ocorrência (occurs check) falha com `TypeErr` cuja mensagem contém `ocorrência`; senão liga.
  - Construtores diferentes: `TypeErr("não unifica ...")`.
  - Funções: unifica argumento e resultado.
  - Registros: campos comuns são unificados. Campos só de um lado exigem linha aberta do outro lado; se a linha é fechada, `TypeErr` com `campo ausente: NOME`. Quando há campos extras dos dois lados, ambas as linhas são ligadas a `{extras | R}` com a mesma `R` nova. Sem campos extras, as linhas são unificadas (fechada com fechada: ok; aberta com fechada: a linha aberta vira vazia).
  - Mesma linha aberta dos dois lados com campos diferentes: `TypeErr` com `ocorrência de linha`.
  - Qualquer outro par: `TypeErr`.

## infer.py
- `infer(expr) -> str`: Algorithm W com `Subst` único. Retorna `pretty` do tipo resolvido. Erros propagam como `TypeErr`.
- Ambiente: `dict nome -> Scheme`. Variável não definida: `TypeErr("variável não definida: NOME")`.
- `var`: instancia o esquema (variáveis quantificadas viram frescas; monomórficas são compartilhadas).
- `lam`: parâmetro monomórfico (`Scheme([], t)`).
- `let`: generaliza as variáveis livres do tipo do valor que não aparecem no ambiente. Corpo com o esquema.
- `app`: unifica o tipo da função com `TFun(tipo_arg, fresca)`, origem `"aplicação"`.
- `if`: condição unificada com `bool` (origem `"condição de if"`); ramos unificados (origem `"ramos de if"`).
- `rec`: `TRec(campos, None)`.
- `proj`: unifica o tipo de `expr` com `TRec({campo: fresca}, linha_nova)`, origem `"acesso .campo"`.
- A origem do `TypeErr` inclui o contexto acumulado (`"lam x"`, `"let f"`, etc.) antes do motivo local.

Não altere este arquivo.
