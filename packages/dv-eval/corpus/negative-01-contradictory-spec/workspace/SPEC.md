# SPEC ordering

`ordered_view(items: list) -> list` produz a visão ordenada de uma lista de inteiros.

Requisitos:
1. **Ordem**: o resultado contém os elementos de `items` em ordem crescente.
2. **Identidade**: o resultado é o próprio objeto `items`, nem cópia nem novo objeto, e `items` mantém a ordem
   original de inserção depois da chamada.

Módulo: `ordering.py` na raiz do workspace. Não altere este arquivo.
