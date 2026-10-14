"""Database engine and session handling. SQLite by default; set KERF_DATABASE_URL for PostgreSQL."""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; they are always UTC here."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    d = as_utc(dt)
    return d.isoformat().replace("+00:00", "Z") if d else None


class Database:
    def __init__(self, url: str):
        kwargs: dict = {"future": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
        self.engine: Engine = create_engine(url, **kwargs)
        if url.startswith("sqlite"):
            @event.listens_for(self.engine, "connect")
            def _pragmas(dbapi_conn, _):  # noqa: ANN001
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()
        self._sessions = sessionmaker(self.engine, expire_on_commit=False, future=True)

    def create_all(self) -> None:
        from . import models  # noqa: F401  (registers the tables)
        from sqlalchemy import inspect, text

        # Presets used to be keyed by (id, version); they are now per school. A primary key cannot be altered, so an
        # older table is moved aside, recreated, and its rows copied back into the default school.
        insp = inspect(self.engine)
        if insp.has_table("presets") and "school_id" not in {c["name"] for c in insp.get_columns("presets")}:
            with self.engine.begin() as conn:
                conn.execute(text("ALTER TABLE presets RENAME TO presets_old"))
        Base.metadata.create_all(self.engine)
        if inspect(self.engine).has_table("presets_old"):
            with self.engine.begin() as conn:
                conn.execute(text(f"INSERT INTO presets (school_id, id, version, data, updated_at, updated_by) "
                                  f"SELECT '{models.DEFAULT_SCHOOL}', id, version, data, updated_at, updated_by FROM presets_old"))
                conn.execute(text("DROP TABLE presets_old"))
        self._add_missing_columns()

    def _add_missing_columns(self) -> None:
        """A light migration: columns added to a model since the database was made are added as nullable columns.

        create_all only makes missing tables; without this an older database would fail on the first query that
        mentions a new column. Nothing is dropped or changed, and rows keep their data (a new column reads as NULL).
        """
        from sqlalchemy import inspect, text

        insp = inspect(self.engine)
        with self.engine.begin() as conn:
            for table in Base.metadata.sorted_tables:
                if not insp.has_table(table.name):
                    continue
                have = {c["name"] for c in insp.get_columns(table.name)}
                for col in table.columns:
                    if col.name not in have:
                        ddl = col.type.compile(dialect=self.engine.dialect)
                        conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl}'))

    @contextmanager
    def session(self) -> Iterator[Session]:
        s = self._sessions()
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()
