# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
# Contagens fixas derivadas dos logs entregues no workspace (linhas que contêm a palavra).
import csv
import os
import sys

EXPECTED = [["severity", "count"], ["ERROR", "3"], ["WARNING", "3"], ["INFO", "10"]]
failures = []

if not os.path.exists("summary.csv"):
    print("FAIL summary.csv ausente")
    sys.exit(1)

with open("summary.csv", newline="") as fh:
    rows = [row for row in csv.reader(fh) if row]

if rows != EXPECTED:
    failures.append(f"conteúdo divergente: {rows!r}")

for line in failures:
    print("FAIL " + line)
if failures:
    sys.exit(1)
print("OK   summary.csv confere com as contagens dos logs")
sys.exit(0)
