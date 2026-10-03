"""Проверка синтаксиса schema.sql (PostgreSQL) через pglast.

Утилита разбивает файл на отдельные операторы, корректно учитывая
строковые литералы ('...'), dollar-quoted блоки ($$...$$) и комментарии (-- ...),
и проверяет каждый оператор парсером PostgreSQL.

Запуск:  python supabase/check_sql.py [путь_к_файлу]
"""
import re
import sys

import pglast


def split_statements(sql: str):
    """Разбивает SQL на операторы по ';' вне строк, $$-блоков и комментариев."""
    parts, buf = [], ""
    in_dollar = in_str = False
    i = 0
    n = len(sql)
    while i < n:
        c = sql[i]
        if not in_str and sql.startswith("$$", i):
            in_dollar = not in_dollar
            buf += "$$"
            i += 2
            continue
        if not in_dollar and not in_str and sql.startswith("--", i):
            j = sql.find("\n", i)
            j = n if j < 0 else j
            buf += sql[i:j]
            i = j
            continue
        if not in_dollar and c == "'":
            in_str = not in_str
        buf += c
        if c == ";" and not in_dollar and not in_str:
            parts.append(buf)
            buf = ""
            i += 1
            continue
        i += 1
    if buf.strip():
        parts.append(buf)
    return parts


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "supabase/schema.sql"
    sql = open(path, encoding="utf-8").read()
    errors = 0
    checked = 0
    for idx, stmt in enumerate(split_statements(sql)):
        code = re.sub(r"--[^\n]*", "", stmt).strip()
        if not code:
            continue
        checked += 1
        try:
            pglast.parse_sql(code + ";")
        except Exception as exc:  # noqa: BLE001
            errors += 1
            print(f"ERROR in statement #{idx}: {exc}")
            print("    " + " ".join(code.split())[:120])
    print(f"Checked {checked} statements, {errors} error(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
