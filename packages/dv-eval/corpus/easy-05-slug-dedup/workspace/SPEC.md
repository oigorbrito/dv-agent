# SPEC slugs

## make_slug(title: str, max_len: int = 40) -> str
Passos:
1. Transliterar para ASCII: caracteres com decomposição NFKD perdem os combinantes (`é` -> `e`).
   Exceções fixas: `ß`->`ss`, `æ`->`ae`, `Æ`->`AE`, `ø`->`o`, `Ø`->`O`, `đ`->`d`, `Đ`->`D`, `ł`->`l`, `Ł`->`L`.
2. Minúsculas.
3. Cada sequência de caracteres fora de `[a-z0-9]` vira um único `-`. Remover `-` das pontas.
4. Limite de tamanho sem cortar palavra ao meio (palavra = trecho entre hífens):
   - se o slug cabe em `max_len`, fica como está;
   - senão, mantém o maior prefixo de palavras inteiras que cabe em `max_len`;
   - se a primeira palavra sozinha não cabe, corta essa palavra em `max_len` caracteres e remove `-` das pontas.
5. Slug vazio resulta em `"item"`.
- `max_len < 1`: `ValueError`.

Exemplos:
- `make_slug("Crème Brûlée")` -> `"creme-brulee"`
- `make_slug("Straße Æther Øl Łódź")` -> `"strasse-aether-ol-lodz"`
- `make_slug("alpha beta gamma delta", 12)` -> `"alpha-beta"`
- `make_slug("abcdefghijklmnop", 5)` -> `"abcde"`
- `make_slug("!!!")` -> `"item"`

## Slugger(reserved: iterable[str] = (), max_len: int = 40)
- `assign(title: str) -> str`: gera o slug base; se já estiver em uso (reservado ou atribuído antes), tenta
  `base-2`, `base-3`, ... (o primeiro número livre, em ordem crescente). O sufixo conta no limite de `max_len`:
  a base é cortada para caber com o sufixo, pelas mesmas regras de palavra inteira.
- Cada slug atribuído passa a ser usado. Resultado depende só da sequência de chamadas (determinístico).

Módulo: `slugs.py` na raiz do workspace. Não altere este arquivo.
