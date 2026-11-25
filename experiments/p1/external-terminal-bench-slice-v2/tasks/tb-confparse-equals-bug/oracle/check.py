# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
# Importa confparse do workspace (cwd) e verifica casos de borda do formato chave = valor.
import sys

try:
    from confparse import parse_config
except Exception as exc:  # módulo ausente ou quebrado no import
    print(f"FAIL import de confparse: {type(exc).__name__}: {exc}")
    sys.exit(1)

CASES = [
    (
        "basico com secoes",
        "a = 1\n[db]\nhost = localhost\nport = 5432\n",
        {"a": "1", "db": {"host": "localhost", "port": "5432"}},
    ),
    (
        "valor com '=' preservado",
        "[svc]\nurl = http://h/?a=1&b=2\n",
        {"svc": {"url": "http://h/?a=1&b=2"}},
    ),
    (
        "comentarios e linhas em branco ignorados",
        "# c\n; d\n\nk = v=w=x\n",
        {"k": "v=w=x"},
    ),
    (
        "valor vazio",
        "empty =\n",
        {"empty": ""},
    ),
]

failures = []
for name, text, expected in CASES:
    try:
        got = parse_config(text)
    except Exception as exc:
        failures.append(f"{name}: exceção {type(exc).__name__}: {exc}")
        continue
    if got != expected:
        failures.append(f"{name}: esperado {expected!r}, obtido {got!r}")

try:
    parse_config("sem igual aqui\n")
    failures.append("linha inválida deveria levantar ValueError")
except ValueError:
    pass

for line in failures:
    print("FAIL " + line)
if failures:
    sys.exit(1)
print("OK   confparse preserva valores com '=' e mantém o restante do comportamento")
sys.exit(0)
