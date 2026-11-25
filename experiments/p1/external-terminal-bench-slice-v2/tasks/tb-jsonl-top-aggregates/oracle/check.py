# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
# Valores esperados fixos, calculados a partir de records_1.jsonl e records_2.jsonl entregues no workspace.
import json
import os
import sys

EXPECTED = {
    "top_2_users_by_amount": {
        "carla": {"total_amount": 25.33, "total_items": 6},
        "ana": {"total_amount": 23.6, "total_items": 5},
    },
    "top_3_tags_by_count": {
        "red": {"count": 7},
        "blue": {"count": 6},
        "green": {"count": 4},
    },
}

if not os.path.exists("aggregates.json"):
    print("FAIL aggregates.json ausente")
    sys.exit(1)

try:
    with open("aggregates.json", encoding="utf-8") as fh:
        data = json.load(fh)
except (json.JSONDecodeError, UnicodeDecodeError) as exc:
    print(f"FAIL aggregates.json inválido: {exc}")
    sys.exit(1)

failures = []
if set(data.keys()) != set(EXPECTED.keys()):
    failures.append(f"chaves de topo divergentes: {sorted(data.keys())}")
for section, expected in EXPECTED.items():
    got = data.get(section)
    if got != expected:
        failures.append(f"{section}: esperado {expected!r}, obtido {got!r}")
    elif section == "top_2_users_by_amount":
        for user, entry in got.items():
            if type(entry["total_items"]) is not int:
                failures.append(f"total_items de {user} não é inteiro")

for line in failures:
    print("FAIL " + line)
if failures:
    sys.exit(1)
print("OK   aggregates.json confere com os valores esperados")
sys.exit(0)
