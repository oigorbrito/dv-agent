# Oráculo externo: roda fora do loop do agente, em cópia isolada. Saída 0 = PASS, 1 = FAIL, outra = NO_VERDICT.
import sys

import calc

CHECKS = [
    ("add", calc.add(2, 3) == 5),
    ("add-negativo", calc.add(-1, 1) == 0),
    ("mul", calc.mul(3, 4) == 12),
    ("safe_div", calc.safe_div(6, 3) == 2),
    ("safe_div-zero", calc.safe_div(1, 0) is None),
]

for name, ok in CHECKS:
    print(("OK   " if ok else "FAIL ") + name)

sys.exit(0 if all(ok for _, ok in CHECKS) else 1)
