# SPEC vmgc

Linguagem, compilador para bytecode de pilha, VM e coletor de lixo. Pacote `vmgc`:
- `compiler.py`: `CompileError(message, line)` e `compile_source(src) -> Program`.
- `vm.py`: `VMError(message, trace)` e `VM(program, threshold=8)` com `run()`, `to_python(value)`, `output`, `heap`.
- `gc.py`: `DanglingReference`, `Ref(handle)`, `ArrayObj(items)`, `Closure(fn_index, captures)` e `Heap(threshold)`.
- `__init__.py` (pronto): `run_source(src, threshold=8)`. Não altere.

## Linguagem
- Comentário: `#` até o fim da linha. Espaços e quebras de linha são separadores.
- Léxico: inteiros; nomes `[A-Za-z_][A-Za-z0-9_]*`; palavras-chave `let in if then else fn nil`;
  símbolos `( ) [ ] , ; = => == < + - *`.
- Programa: zero ou mais declarações globais `let NOME = EXPR;` seguidas de uma EXPR final.
  Atalho: se após `let NOME = EXPR` vier `in`, a construção é uma expressão `let` local e é a EXPR final.
- Gramática (precedência crescente):
```
EXPR  := let NOME = EXPR in EXPR | if EXPR then EXPR else EXPR | fn ( [NOME (, NOME)*] ) => EXPR | CMP
CMP   := SOMA [ (< | ==) SOMA ]
SOMA  := PROD ( (+ | -) PROD )*
PROD  := UNARIO ( * UNARIO )*
UNARIO:= - UNARIO | POS
POS   := PRIM ( ( [EXPR (, EXPR)*] ) | [ EXPR ] )*        (chamada e índice)
PRIM  := INT | NOME | nil | ( EXPR ) | [ [EXPR (, EXPR)*] ]   (literal de array)
```
- `<` e `==` produzem `1` (verdadeiro) ou `0`. `==` compara inteiros por valor, `nil` com `nil`, e referências
  por identidade; tipos diferentes são falsos (não é erro).
- `if` considera falso somente `0` e `nil`; qualquer outro valor (inclusive array e função) é verdadeiro.
- `+`, `-`, `*`, `<` e unário `-` exigem inteiros (senão `VMError`).
- Declarações globais são visíveis em todo o programa, inclusive em funções definidas antes delas (resolução em tempo de execução).
- Nomes de builtin: `new(n)` (array de n `nil`, n inteiro >= 0), `len(a)`, `set(a, i, v)` (grava e devolve `v`),
  `print(v)` (registra o valor em `vm.output` e devolve `v`). Aridade fixa: 1, 1, 3, 1.

## Compilação
- `CompileError(message, line)`, com `line` = linha do token problemático. Erros: nome indefinido (não local,
  não global do programa, não builtin), sintaxe, builtin usada como valor, aridade de builtin errada no literal da chamada,
  declaração global repetida.
- Funções são closures: uma `fn` captura, por valor, as variáveis locais do escopo léxico que usa (também capturas
  transitivas de funções externas). Globais não são capturadas.

## VM
- Pilha de operandos e pilha de frames. Cada frame tem `locals` (parâmetros e lets, por slot), `captures` e `ip`.
- Chamada: `f(a, b)`: aridade diferente da declarada, ou valor que não é closure: `VMError`.
- `VMError(message, trace)`: `trace` é a lista `(nome_da_função, linha)` do frame mais interno para o mais externo.
  Nome: `main` para o programa; `fn@L` para uma `fn` declarada na linha `L` (linha da palavra `fn`).
  Linha = linha da instrução que falhou (operador, `(` da chamada, `[` do índice) em cada frame.
- Índice fora do intervalo, índice não inteiro, indexar não-array: `VMError`.
- Global lida antes de ser definida: `VMError("global indefinida: NOME")`.
- `to_python(v)`: inteiros e `None` como estão; array como lista (recursivo); função como `"<fn>"`;
  referência já vista no caminho atual como `"<ciclo>"`.

## GC (mark-and-sweep)
- Objetos da heap: arrays e closures. Handles são inteiros crescentes **nunca reutilizados**.
- `Heap.alloc(obj, roots)`: se já houve `threshold` alocações desde a última coleta, coleta **antes** de alocar,
  usando `roots()` como raízes. Depois registra `obj` e devolve `Ref`. Contadores: `allocations` (total),
  `collections`, e `len(objects)` = objetos vivos.
- Raízes: valores das globais, locais e capturas de todos os frames, e toda a pilha de operandos.
  Na criação de array ou closure, os operandos ainda estão na pilha, então não são coletados.
- Marcação percorre elementos de arrays **e** capturas de closures, com cuidado para ciclos.
- Coletado = não marcado. `Heap.get(ref)` de handle coletado: `DanglingReference`, que a VM converte em
  `VMError("referência inválida (coletada pelo GC)", trace)`.
- Trocar o `threshold` não muda o resultado de um programa, só `collections` e `live`.

Não altere este arquivo.
