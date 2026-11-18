from sqlalchemy import inspect, text
from sqlmodel import Session, SQLModel, create_engine

from .config import settings

engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})


def add_missing_columns(eng=None) -> list[str]:
    """Tiny dev-time migration: `create_all` never alters existing tables, so a database created by an
    older version of the code lacks newer columns. Add any missing (nullable) columns in place.
    Returns the list of added "table.column" names. For production use a real migration tool (Alembic)."""
    eng = eng or engine
    added = []
    insp = inspect(eng)
    for table in SQLModel.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue
        have = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name in have:
                continue
            default_sql = ""
            if col.default is not None and getattr(col.default, "is_scalar", False):
                v = col.default.arg
                default_sql = f" DEFAULT {int(v)}" if isinstance(v, (bool, int)) else f" DEFAULT '{v}'"
            if not col.nullable and not default_sql and col.server_default is None:
                raise RuntimeError(f"Cannot auto-add NOT NULL column {table.name}.{col.name}; migrate manually")
            ddl = col.type.compile(eng.dialect) + default_sql   # existing rows get the Python-side default
            with eng.begin() as conn:
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl}'))
            added.append(f"{table.name}.{col.name}")
    return added


def init_db() -> None:
    from . import models  # noqa: F401  (registers tables)
    SQLModel.metadata.create_all(engine)
    added = add_missing_columns(engine)
    if added:
        import logging
        logging.getLogger("uvicorn.error").warning("Database upgraded, added columns: %s", ", ".join(added))


def get_session():
    with Session(engine) as session:
        yield session
