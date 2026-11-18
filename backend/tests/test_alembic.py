"""Alembic migrations: a fresh database built by `upgrade head` must match the models exactly,
and an old (Phase 1-9) database must upgrade without losing data."""
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlmodel import SQLModel

from app import models  # noqa: F401

BACKEND = Path(__file__).resolve().parent.parent


def cfg(url: str) -> Config:
    c = Config(str(BACKEND / "alembic.ini"))
    c.set_main_option("script_location", str(BACKEND / "alembic"))
    c.set_main_option("sqlalchemy.url", url)
    return c


def schema(engine) -> dict[str, set[str]]:
    insp = inspect(engine)
    return {t: {c["name"] for c in insp.get_columns(t)} for t in insp.get_table_names() if t != "alembic_version"}


def test_upgrade_head_on_empty_db_matches_models(tmp_path):
    url = f"sqlite:///{(tmp_path / 'fresh.db').as_posix()}"
    command.upgrade(cfg(url), "head")
    migrated = schema(create_engine(url))
    reference_engine = create_engine(f"sqlite:///{(tmp_path / 'ref.db').as_posix()}")
    SQLModel.metadata.create_all(reference_engine)
    assert migrated == schema(reference_engine)          # same tables and columns as the models


def test_upgrade_from_baseline_keeps_users_and_adds_defaults(tmp_path):
    url = f"sqlite:///{(tmp_path / 'old.db').as_posix()}"
    command.upgrade(cfg(url), "0001")                    # schema as of Phase 9
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text("INSERT INTO user (email, full_name, password_hash, role, language, created_at) "
                       "VALUES ('old@x.com', 'Old', 'h', 'tourist', 'en', '2026-01-01 00:00:00')"))
    assert "disabled" not in schema(eng)["user"]
    command.upgrade(cfg(url), "head")
    assert {"disabled", "token_version"} <= schema(create_engine(url))["user"]
    with create_engine(url).connect() as c:
        row = c.execute(text("SELECT email, disabled, token_version FROM user")).one()
    assert tuple(row) == ("old@x.com", 0, 0)             # data kept, safe defaults applied


def test_downgrade_removes_the_new_columns(tmp_path):
    url = f"sqlite:///{(tmp_path / 'd.db').as_posix()}"
    command.upgrade(cfg(url), "head")
    command.downgrade(cfg(url), "0001")
    assert "disabled" not in schema(create_engine(url))["user"]


def test_dev_fallback_adds_the_same_columns_with_defaults(tmp_path):
    """The create_all + add_missing_columns path (used in development) must agree with Alembic."""
    from app import db as appdb
    eng = create_engine(f"sqlite:///{(tmp_path / 'dev.db').as_posix()}")
    command.upgrade(cfg(f"sqlite:///{(tmp_path / 'dev.db').as_posix()}"), "0001")
    with eng.begin() as c:
        c.execute(text("INSERT INTO user (email, full_name, password_hash, role, language, created_at) "
                       "VALUES ('o@x.com', 'O', 'h', 'tourist', 'en', '2026-01-01 00:00:00')"))
    assert {"user.disabled", "user.token_version"} <= set(appdb.add_missing_columns(eng))
    with eng.connect() as c:
        assert tuple(c.execute(text("SELECT disabled, token_version FROM user")).one()) == (0, 0)
