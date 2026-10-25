"""Create the CivicAI MySQL database (and optionally a dedicated MySQL user), then migrate and fill it.

Django cannot create the database itself, so this script connects to the MySQL *server* with the
credentials in backend/.env and runs:

    CREATE DATABASE IF NOT EXISTS `<DATABASE_NAME>` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

Usage (from backend/, with the virtual environment):

    venv/Scripts/python.exe scripts/setup_mysql.py                    # create the database only
    venv/Scripts/python.exe scripts/setup_mysql.py --migrate --seed   # + tables + reference data + demo data
    venv/Scripts/python.exe scripts/setup_mysql.py --copy-sqlite      # + tables + a copy of civicai.sqlite3
    venv/Scripts/python.exe scripts/setup_mysql.py --create-user civicai --migrate --seed
        # also creates MySQL user 'civicai' (password asked interactively) with rights on the
        # CivicAI database only, and prints the .env lines to switch the app to that user.

``--copy-sqlite [PATH]`` moves an installation that was developed on SQLite to MySQL with every row and primary
key unchanged (complaint numbers, logins and media references stay the same): ``migrate`` on MySQL, ``dumpdata``
from the SQLite file (default backend/civicai.sqlite3), ``loaddata`` into MySQL, then ``init_civicai
--keep-existing``. The MySQL database must be empty; ``--replace`` first deletes every row it holds (``flush``).
Uploaded photos are not copied: both databases refer to the same files in ``MEDIA_DIR``.

The admin credentials come from backend/.env (DATABASE_USER / DATABASE_PASSWORD / DATABASE_HOST /
DATABASE_PORT); use --admin-user / --admin-password to override them (e.g. root for the first run).
Remember to set DB_ENGINE=mysql in backend/.env before running the server against MySQL.
"""
import argparse
import getpass
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

try:
    from dotenv import load_dotenv

    load_dotenv(BACKEND / ".env")
except ImportError:  # pragma: no cover
    pass

IDENTIFIER = re.compile(r"^[A-Za-z0-9_]{1,64}$")
#: Rows ``migrate`` creates itself (with its own primary keys) or that only make sense on the old server.
DUMP_EXCLUDES = ("contenttypes", "auth.permission", "admin.logentry", "sessions.session")


def connect(host, port, user, password, database=None):
    """Connect to the MySQL server (optionally selecting a database) with mysqlclient or PyMySQL."""
    options = {"charset": "utf8mb4"}
    try:
        import MySQLdb

        if database:
            options["db"] = database
        return MySQLdb.connect(host=host, port=port, user=user, passwd=password, **options)
    except ImportError:
        import pymysql

        if database:
            options["database"] = database
        return pymysql.connect(host=host, port=port, user=user, password=password, **options)


def run_manage(*args, engine="mysql", extra_env=None):
    print(f"\n$ python manage.py {' '.join(args)}   (DB_ENGINE={engine})")
    # UTF-8 mode: dumpdata / loaddata files must not depend on the Windows code page (cp1252 cannot hold "→").
    env = dict(os.environ, DB_ENGINE=engine, PYTHONUTF8="1", **(extra_env or {}))
    subprocess.run([sys.executable, "manage.py", *args], cwd=BACKEND, env=env, check=True)


def database_row_count(host, port, user, password, database):
    """Rows in the accounts table of ``database`` (0 when the table does not exist yet)."""
    conn = connect(host, port, user, password, database)
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = %s "
                    "AND table_name = 'accounts_user'", (database,))
        if not cur.fetchone()[0]:
            return 0
        cur.execute("SELECT COUNT(*) FROM accounts_user")
        return int(cur.fetchone()[0])
    finally:
        conn.close()


def copy_sqlite(sqlite_path, *, replace, server):
    """migrate MySQL, dumpdata from ``sqlite_path``, loaddata into MySQL, complete the reference data."""
    sqlite_path = Path(sqlite_path).resolve()
    if not sqlite_path.is_file():
        print(f"SQLite database not found: {sqlite_path}")
        return 1
    run_manage("migrate", "--noinput")
    existing = database_row_count(*server)
    if existing and not replace:
        print(f"\nThe MySQL database already holds {existing} user account(s); nothing was copied. Run again with "
              "--replace to delete every row in it first, or point DATABASE_NAME at an empty database.")
        return 1
    if replace:
        run_manage("flush", "--noinput")
    with tempfile.TemporaryDirectory(prefix="civicai-copy-") as folder:
        dump = Path(folder) / "civicai-data.json"
        excludes = [arg for name in DUMP_EXCLUDES for arg in ("--exclude", name)]
        run_manage("dumpdata", *excludes, "--output", str(dump), engine="sqlite",
                   extra_env={"SQLITE_NAME": str(sqlite_path)})
        print(f"Exported {dump.stat().st_size / 1e6:.1f} MB of data from {sqlite_path.name}.")
        run_manage("loaddata", str(dump))
    run_manage("init_civicai", "--keep-existing")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--admin-user", default=os.environ.get("DATABASE_USER", "root"))
    parser.add_argument("--admin-password", default=None, help="defaults to DATABASE_PASSWORD from .env (asked if empty)")
    parser.add_argument("--host", default=os.environ.get("DATABASE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("DATABASE_PORT", "3306")))
    parser.add_argument("--database", default=os.environ.get("DATABASE_NAME", "civicai"))
    parser.add_argument("--create-user", metavar="NAME", help="also create this MySQL user with rights on the database")
    parser.add_argument("--migrate", action="store_true", help="run migrate + init_civicai afterwards")
    parser.add_argument("--seed", action="store_true", help="run seed_demo --reset afterwards (implies --migrate)")
    parser.add_argument("--copy-sqlite", nargs="?", const=str(BACKEND / "civicai.sqlite3"), metavar="PATH",
                        help="copy every row of this SQLite database (default civicai.sqlite3) into MySQL")
    parser.add_argument("--replace", action="store_true",
                        help="with --copy-sqlite: delete all rows of the MySQL database before copying")
    args = parser.parse_args()

    if not IDENTIFIER.match(args.database):
        parser.error("database name may only contain letters, digits and underscores")
    if args.create_user and not IDENTIFIER.match(args.create_user):
        parser.error("user name may only contain letters, digits and underscores")
    if args.copy_sqlite and args.seed:
        parser.error("choose either --seed (fresh demo data) or --copy-sqlite (the existing SQLite data)")

    password = args.admin_password if args.admin_password is not None else os.environ.get("DATABASE_PASSWORD", "")
    if not password:
        password = getpass.getpass(f"MySQL password for {args.admin_user}@{args.host}: ")

    print(f"Connecting to MySQL at {args.host}:{args.port} as {args.admin_user} ...")
    try:
        conn = connect(args.host, args.port, args.admin_user, password)
    except Exception as exc:  # noqa: BLE001 - show the driver's message to the user
        print(f"Could not connect: {exc}")
        print("Check that the MySQL80 service is running and that DATABASE_USER / DATABASE_PASSWORD in backend/.env are right.")
        return 1

    cur = conn.cursor()
    cur.execute("SELECT VERSION()")
    print(f"Connected. Server version: {cur.fetchone()[0]}")
    cur.execute(
        f"CREATE DATABASE IF NOT EXISTS `{args.database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    )
    print(f"Database `{args.database}` is ready (utf8mb4).")

    app_user, app_password = args.admin_user, password
    if args.create_user:
        user_password = getpass.getpass(f"Password for the new MySQL user '{args.create_user}': ")
        if len(user_password) < 8:
            print("Use at least 8 characters for the database user's password.")
            return 1
        cur.execute(f"CREATE USER IF NOT EXISTS '{args.create_user}'@'localhost' IDENTIFIED BY %s", (user_password,))
        cur.execute(f"GRANT ALL PRIVILEGES ON `{args.database}`.* TO '{args.create_user}'@'localhost'")
        # Django's test runner creates test_<name>; allow it too.
        cur.execute(f"GRANT ALL PRIVILEGES ON `test_{args.database}`.* TO '{args.create_user}'@'localhost'")
        cur.execute("FLUSH PRIVILEGES")
        print(f"User '{args.create_user}'@'localhost' created with rights on `{args.database}` and `test_{args.database}`.")
        print("Put these lines in backend/.env:")
        print(f"  DB_ENGINE=mysql\n  DATABASE_NAME={args.database}\n  DATABASE_USER={args.create_user}\n"
              "  DATABASE_PASSWORD=<the password you just typed>")
        os.environ["DATABASE_USER"] = args.create_user
        os.environ["DATABASE_PASSWORD"] = user_password
        app_user, app_password = args.create_user, user_password
    else:
        os.environ["DATABASE_PASSWORD"] = password
    conn.commit()
    conn.close()

    os.environ["DATABASE_NAME"] = args.database
    os.environ["DATABASE_HOST"] = args.host
    os.environ["DATABASE_PORT"] = str(args.port)
    if args.copy_sqlite:
        result = copy_sqlite(args.copy_sqlite, replace=args.replace,
                             server=(args.host, args.port, app_user, app_password, args.database))
        if result:
            return result
    elif args.migrate or args.seed:
        run_manage("migrate", "--noinput")
        run_manage("init_civicai", "--keep-existing")
    if args.seed:
        run_manage("seed_demo", "--reset")
    print("\nDone. Set DB_ENGINE=mysql in backend/.env (if not already) and start the server.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
