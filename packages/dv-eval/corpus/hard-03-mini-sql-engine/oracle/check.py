# Oráculo externo (oculto do agente). Saída 0 = PASS, 1 = FAIL.
import sys

RESULTS = []


def check(name, fn):
    try:
        ok = bool(fn())
    except Exception as exc:
        print(f"FAIL {name}: {type(exc).__name__}: {exc}")
        RESULTS.append(False)
        return
    print(("OK   " if ok else "FAIL ") + name)
    RESULTS.append(ok)


try:
    import minisql as ms
except Exception as exc:
    print(f"FAIL import minisql: {exc}")
    sys.exit(1)


def build():
    db = ms.Database()
    db.create_table("users", ["id", "name", "age", "city"])
    for row in [(1, "Ana", 31, "Recife"), (2, "Bruno", 25, "Recife"), (3, "Carla", None, "Salvador"),
                (4, "Diego", 40, None)]:
        db.insert("users", row)
    db.create_table("orders", ["id", "user_id", "amount", "status"])
    for row in [(10, 1, 100, "paid"), (11, 1, 50, "open"), (12, 2, 70, "paid"), (13, 9, 30, "paid"),
                (14, None, 20, "paid")]:
        db.insert("orders", row)
    db.create_table("quotes", ["id", "txt"])
    db.insert("quotes", (1, "O'Neil"))
    return db


def rows(db, sql):
    return db.query(sql).rows


def cols(db, sql):
    return db.query(sql).columns


def raises(fn):
    try:
        fn()
    except ms.SQLError:
        return True
    return False


try:
    db = build()
except Exception as exc:
    print(f"FAIL setup do banco: {type(exc).__name__}: {exc}")
    sys.exit(1)

check("filtro com comparação e ORDER BY",
      lambda: rows(db, "SELECT name FROM users WHERE age > 30 ORDER BY name") == [("Ana",), ("Diego",)])
check("NULL não casa em comparação (Carla fora de age > 30)",
      lambda: ("Carla",) not in rows(db, "SELECT name FROM users WHERE age > 30"))
check("precedência: AND antes de OR",
      lambda: rows(db, "SELECT name FROM users WHERE name = 'Carla' OR age > 30 AND city = 'Recife'")
      == [("Ana",), ("Carla",)])
check("parênteses alteram a precedência",
      lambda: rows(db, "SELECT name FROM users WHERE (age < 30 OR age > 35) AND city = 'Recife'") == [("Bruno",)])
check("qualificador pelo nome da tabela sem alias", lambda: rows(
    db, "SELECT users.name FROM users WHERE users.id = 2") == [("Bruno",)])
check("alias AS em coluna simples", lambda: cols(db, "SELECT name AS n FROM users WHERE id = 1") == ["n"]
      and rows(db, "SELECT name AS n FROM users WHERE id = 1") == [("Ana",)])
check("inteiro negativo e intervalo", lambda: rows(
    db, "SELECT name FROM users WHERE age > -1 AND age < 100") == [("Ana",), ("Bruno",), ("Diego",)])
check("string com aspas escapadas", lambda: rows(db, "SELECT txt FROM quotes WHERE txt = 'O''Neil'") == [("O'Neil",)])
check("<> equivale a !=", lambda: rows(db, "SELECT name FROM users WHERE city <> 'Recife'") == [("Carla",)])
check("comparação com NULL é sempre falsa", lambda: rows(db, "SELECT name FROM users WHERE city = NULL") == []
      and rows(db, "SELECT name FROM users WHERE city != NULL") == [])
check("INNER JOIN com ORDER BY",
      lambda: rows(db, "SELECT u.name, o.amount FROM users u INNER JOIN orders o ON u.id = o.user_id "
                       "ORDER BY o.amount") == [("Ana", 50), ("Bruno", 70), ("Ana", 100)])
check("INNER JOIN: nomes de saída qualificados",
      lambda: cols(db, "SELECT u.name, o.amount FROM users u INNER JOIN orders o ON u.id = o.user_id")
      == ["u.name", "o.amount"])
check("LEFT JOIN preserva a esquerda sem par",
      lambda: rows(db, "SELECT u.name, o.id FROM users u LEFT JOIN orders o ON u.id = o.user_id")
      == [("Ana", 10), ("Ana", 11), ("Bruno", 12), ("Carla", None), ("Diego", None)])
check("SELECT * com JOIN expande alias.coluna", lambda: cols(
    db, "SELECT * FROM users u INNER JOIN orders o ON u.id = o.user_id") == [
    "u.id", "u.name", "u.age", "u.city", "o.id", "o.user_id", "o.amount", "o.status"]
      and rows(db, "SELECT * FROM users u INNER JOIN orders o ON u.id = o.user_id WHERE o.id = 12")
      == [(2, "Bruno", 25, "Recife", 12, 2, 70, "paid")])
check("SELECT * sem JOIN", lambda: cols(db, "SELECT * FROM users") == ["id", "name", "age", "city"]
      and len(rows(db, "SELECT * FROM users")) == 4)
GROUP_SQL = ("SELECT o.status, COUNT(*) AS n, SUM(o.amount) AS total, AVG(o.amount) AS avg, "
             "MIN(o.amount) AS lo, MAX(o.amount) AS hi FROM orders o GROUP BY o.status ORDER BY o.status")
check("GROUP BY com COUNT, SUM, AVG, MIN, MAX",
      lambda: rows(db, GROUP_SQL) == [("open", 1, 50, 50.0, 50, 50), ("paid", 4, 220, 55.0, 20, 100)])
check("GROUP BY: nomes de saída", lambda: cols(db, GROUP_SQL) == ["o.status", "n", "total", "avg", "lo", "hi"])
check("COUNT(col) ignora NULL, COUNT(*) não",
      lambda: rows(db, "SELECT COUNT(u.age) AS c, COUNT(*) AS n FROM users u") == [(3, 4)])
check("agregação sem GROUP BY sobre zero linhas produz uma linha",
      lambda: rows(db, "SELECT COUNT(*) AS n, SUM(u.age) AS s FROM users u WHERE u.age > 100") == [(0, None)])
check("HAVING filtra grupos por agregação e ORDER BY por alias",
      lambda: rows(db, "SELECT o.user_id, SUM(o.amount) AS total FROM orders o GROUP BY o.user_id "
                       "HAVING SUM(o.amount) > 60 ORDER BY total") == [(2, 70), (1, 150)])
check("NULL forma grupo próprio, na ordem da primeira aparição", lambda: rows(
    db, "SELECT o.user_id, COUNT(*) AS n FROM orders o GROUP BY o.user_id") == [(1, 2), (2, 1), (9, 1), (None, 1)])
check("ORDER BY ASC: NULL por último",
      lambda: rows(db, "SELECT u.name, u.age FROM users u ORDER BY u.age")
      == [("Bruno", 25), ("Ana", 31), ("Diego", 40), ("Carla", None)])
check("ORDER BY DESC: NULL continua por último",
      lambda: rows(db, "SELECT u.name, u.age FROM users u ORDER BY u.age DESC")
      == [("Diego", 40), ("Ana", 31), ("Bruno", 25), ("Carla", None)])
check("ORDER BY é estável nos empates", lambda: rows(db, "SELECT o.status, o.id FROM orders o ORDER BY o.status")
      == [("open", 11), ("paid", 10), ("paid", 12), ("paid", 13), ("paid", 14)])
check("ORDER BY com dois operandos", lambda: rows(
    db, "SELECT o.status, o.id FROM orders o ORDER BY o.status DESC, o.id DESC")
      == [("paid", 14), ("paid", 13), ("paid", 12), ("paid", 10), ("open", 11)])


def explain_index_before_after():
    d = build()
    before = d.explain("SELECT name FROM users WHERE city = 'Recife'")
    d.create_index("users", "city")
    after = d.explain("SELECT name FROM users WHERE city = 'Recife'")
    return before == ["SEQ_SCAN users", "FILTER"] and after == ["INDEX_LOOKUP users.city", "FILTER"]


def index_same_result():
    d = build()
    sql = "SELECT name FROM users WHERE city = 'Recife' ORDER BY name"
    before = rows(d, sql)
    d.create_index("users", "city")
    d.create_index("users", "age")
    return before == rows(d, sql) == [("Ana",), ("Bruno",)] and rows(
        d, "SELECT name FROM users WHERE age = 31") == [("Ana",)]


def index_not_used_when_unsafe():
    d = build()
    d.create_index("users", "city")
    d.create_index("users", "age")
    return (d.explain("SELECT name FROM users WHERE city = NULL")[0] == "SEQ_SCAN users"
            and d.explain("SELECT name FROM users WHERE city = 'Recife' OR age = 1")[0] == "SEQ_SCAN users"
            and d.explain("SELECT u.name FROM users u INNER JOIN orders o ON u.id = o.user_id "
                          "WHERE u.city = 'Recife'")[0] == "SEQ_SCAN users")


check("explain: índice só quando é seguro usar", explain_index_before_after)
check("índice não muda o resultado", index_same_result)
check("explain: índice recusado para NULL, OR e JOIN", index_not_used_when_unsafe)
check("explain: passos do JOIN, filtro, agregação e ordenação", lambda: db.explain(
    "SELECT o.status, COUNT(*) FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id > 0 "
    "GROUP BY o.status ORDER BY o.status") == ["SEQ_SCAN orders", "NESTED_LOOP_LEFT_JOIN users", "FILTER",
                                               "GROUP_AGGREGATE", "SORT"])
check("erro: tabela desconhecida", lambda: raises(lambda: db.query("SELECT * FROM nope")))
check("erro: coluna ambígua em JOIN",
      lambda: raises(lambda: db.query("SELECT id FROM users u INNER JOIN orders o ON u.id = o.user_id")))
check("erro: função desconhecida", lambda: raises(lambda: db.query("SELECT FOO(id) FROM users")))
check("erro: coluna não agregada", lambda: raises(
    lambda: db.query("SELECT u.name, COUNT(*) FROM users u GROUP BY u.city")))
check("erro: sintaxe", lambda: raises(lambda: db.query("SELECT FROM users")))
check("erro: tipos incomparáveis", lambda: raises(lambda: db.query("SELECT name FROM users WHERE name > 3")))
check("erro: ORDER BY fora da seleção", lambda: raises(lambda: db.query("SELECT name FROM users ORDER BY age")))
check("erro: SUM sobre texto", lambda: raises(lambda: db.query("SELECT SUM(u.name) FROM users u")))
check("erro: string não fechada", lambda: raises(lambda: db.query("SELECT name FROM users WHERE name = 'x")))
check("erro: texto sobrando (LIMIT não existe)", lambda: raises(lambda: db.query("SELECT name FROM users LIMIT 2")))
check("erro: tabela duplicada", lambda: raises(lambda: db.create_table("users", ["x"])))

sys.exit(0 if all(RESULTS) else 1)
