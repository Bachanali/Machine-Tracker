"""
Machine Breakdown Tracker - Unit-01 (45mtr)
Professional Flask app: login, role-based access, sidebar navigation,
dashboard, logs, add-data, reports (with CSV export), user management,
and settings (manage dropdown lists + change password).

Run:
    pip install -r requirements.txt
    python app.py

Default login (change this after first login):
    username: admin
    password: admin123
"""

import calendar
import io
import logging
import os
import re
import secrets
import time
import sqlite3
import uuid
from logging.handlers import RotatingFileHandler
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from flask import (
    Flask, Response, flash, g, jsonify, redirect, render_template,
    request, session, url_for,
)
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.formatting.rule import DataBarRule
from werkzeug.security import check_password_hash, generate_password_hash

from seed_data import (
    SEED_RECORDS, MACHINES, SHIFTS, FAULT_CATEGORIES, TECHNICIANS,
    COMPLAINT_REFERENCES, NOTIFICATION_TYPES, DEVICE_DETAILS, DEVICE_SUB_CATEGORIES, DEFAULT_UNIT_NAME,
    UNIT2_NAME, SEED_RECORDS_UNIT2, MACHINES_UNIT2, SHIFTS_UNIT2, FAULT_CATEGORIES_UNIT2,
    TECHNICIANS_UNIT2, COMPLAINT_REFERENCES_UNIT2, NOTIFICATION_TYPES_UNIT2, DEVICE_DETAILS_UNIT2, DEVICE_SUB_CATEGORIES_UNIT2,
)

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "breakdown.db"
SECRET_PATH = BASE_DIR / "data" / "secret.key"
LOG_PATH = BASE_DIR / "data" / "app.log"
DB_PATH.parent.mkdir(exist_ok=True)

HOST = "0.0.0.0"   # network par accessible
PORT = 5115

# ---- Session name (login cookie ka naam) ----
# Browsers cookies ko sirf hostname se pehchante hain, PORT se nahi. Is liye
# agar ek hi PC par is app ki DO copies chal rahi hon (masalan ek "45mtr" ke
# liye aur ek "D-12" ke liye, alag-alag PORT par), aur dono ka session name
# aik jaisa ho, to ek project se logout karne par doosra bhi logout ho jata hai.
#
# Isay theek karne ke liye har copy ka session name alag hona chahiye. Neeche
# by default PORT ke sath khud-ba-khud unique bana diya jata hai (5115 ke liye
# "breakdown_tracker_5115"), is liye alag PORT wali har copy pehle se alag hai.
# Agar aap chahein to yahan apna koi bhi naam de sakte hain — bas har copy mein
# alag rakhein (masalan "tracker_45mtr" aur "tracker_d12").
SESSION_NAME = os.environ.get("BT_SESSION_NAME") or f"breakdown_tracker_{PORT}"

app = Flask(__name__)

if not SECRET_PATH.exists():
    SECRET_PATH.write_text(secrets.token_hex(32))
app.secret_key = SECRET_PATH.read_text().strip()

# 24/7 par chalne wali app ke liye disk par logs rakhna zaroori hai (koi
# hamesha console nahi dekh raha hoga) — 2MB x 5 files tak rotate hoti hain,
# taake purani logs khud-ba-khud delete ho jayen aur disk bhar na jaye.
_log_handler = RotatingFileHandler(LOG_PATH, maxBytes=2_000_000, backupCount=5, encoding="utf-8")
_log_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
_log_handler.setLevel(logging.INFO)
app.logger.addHandler(_log_handler)
app.logger.setLevel(logging.INFO)
logging.getLogger("waitress").addHandler(_log_handler)
logging.getLogger("waitress").setLevel(logging.INFO)

# Each copy of the app gets its own uniquely-named login cookie (see SESSION_NAME
# above). Because browsers scope cookies by hostname only — NOT by port — two
# copies on the same PC would otherwise share one cookie and log each other out.
app.config["SESSION_COOKIE_NAME"] = SESSION_NAME


# ---------------------------------------------------------------- database

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        # WAL mode lets readers (Dashboard/Logs/auto-refresh) run WITHOUT
        # blocking on writers (Add Data/Edit), and vice versa. Without this,
        # SQLite's default journal mode serializes all access to the file, so
        # under sustained multi-client 24/7 use (many browser tabs polling +
        # people entering data) requests start queueing up behind each other
        # and pages get slower and slower to open the longer the app stays up.
        g.db.execute("PRAGMA journal_mode = WAL")
        # If a lock IS momentarily held, wait up to 5s and retry instead of
        # failing immediately with "database is locked".
        g.db.execute("PRAGMA busy_timeout = 5000")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS records (
            id TEXT PRIMARY KEY, date TEXT, complaintReference TEXT, notificationType TEXT, ticketNo TEXT, orderNo TEXT,
            unit TEXT, machine TEXT, machineNo TEXT,
            deviceDetail TEXT, deviceSubCat TEXT, faultCategory TEXT,
            reason TEXT, actionTaken TEXT, shift TEXT, technician TEXT,
            timeStart TEXT, timeFinish TEXT, downtime TEXT, remarks TEXT,
            createdAt TEXT
        )
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS units (
            id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, createdAt TEXT
        )
    """)

    # upgrade path for existing databases created before these columns existed
    existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(records)")}
    if "complaintReference" not in existing_cols:
        conn.execute("ALTER TABLE records ADD COLUMN complaintReference TEXT DEFAULT ''")
    if "notificationType" not in existing_cols:
        conn.execute("ALTER TABLE records ADD COLUMN notificationType TEXT DEFAULT ''")
    if "ticketNo" not in existing_cols:
        conn.execute("ALTER TABLE records ADD COLUMN ticketNo TEXT DEFAULT ''")
    if "orderNo" not in existing_cols:
        conn.execute("ALTER TABLE records ADD COLUMN orderNo TEXT DEFAULT ''")
    if "unit" not in existing_cols:
        conn.execute("ALTER TABLE records ADD COLUMN unit TEXT DEFAULT ''")

    # Indexes for every column the dashboard/logs/reports filter or sort by.
    # Without these, every request does a full table scan of `records`; that's
    # invisible with a small table but gets progressively slower as months of
    # breakdown entries pile up, especially under sustained multi-client use.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_records_unit ON records(unit)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_records_machine ON records(machine)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_records_shift ON records(shift)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_records_fault ON records(faultCategory)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_records_complaint ON records(complaintReference)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_records_notification ON records(notificationType)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_records_date_created ON records(date, createdAt)")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'operator',
            can_add_data INTEGER DEFAULT 0, can_edit_delete INTEGER DEFAULT 0,
            createdAt TEXT
        )
    """)
    user_cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
    if "can_add_data" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN can_add_data INTEGER DEFAULT 0")
    if "can_edit_delete" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN can_edit_delete INTEGER DEFAULT 0")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS reference_items (
            id TEXT PRIMARY KEY, category TEXT NOT NULL, value TEXT NOT NULL, unit TEXT DEFAULT '',
            UNIQUE(category, value, unit)
        )
    """)
    ref_cols = {row["name"] for row in conn.execute("PRAGMA table_info(reference_items)")}
    if "unit" not in ref_cols:
        conn.execute("ALTER TABLE reference_items ADD COLUMN unit TEXT DEFAULT ''")

    # Per-technician standard working hours per day (some work 8h, some 12h),
    # used to compute daily/monthly/yearly efficiency. Defaults to 8 when unset.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS technician_hours (
            technician TEXT PRIMARY KEY, daily_hours REAL DEFAULT 8, updatedAt TEXT
        )
    """)
    # Per-DAY working-hours overrides: a technician may work 8h one day and 12h
    # another. When a date has no override, the technician's default (above) is
    # used. Efficiency for a day = minutes worked / (that day's hours x 60).
    conn.execute("""
        CREATE TABLE IF NOT EXISTS technician_day_hours (
            technician TEXT, date TEXT, daily_hours REAL, updatedAt TEXT,
            PRIMARY KEY (technician, date)
        )
    """)
    conn.commit()

    if conn.execute("SELECT COUNT(*) FROM units").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO units (id, name, createdAt) VALUES (?,?,?)",
            ("unit-" + uuid.uuid4().hex[:10], DEFAULT_UNIT_NAME, now_iso()),
        )

    if conn.execute("SELECT COUNT(*) FROM records").fetchone()[0] == 0:
        for rec in SEED_RECORDS:
            conn.execute(
                """INSERT INTO records
                   (id, date, complaintReference, ticketNo, unit, machine, machineNo, deviceDetail, deviceSubCat,
                    faultCategory, reason, actionTaken, shift, technician,
                    timeStart, timeFinish, downtime, remarks, createdAt)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    rec["id"], rec["date"], rec.get("complaintReference", ""), rec.get("ticketNo", ""),
                    DEFAULT_UNIT_NAME, rec["machine"], rec.get("machineNo", ""),
                    rec.get("deviceDetail", ""), rec.get("deviceSubCat", ""),
                    rec["faultCategory"], rec.get("reason", ""), rec.get("actionTaken", ""),
                    rec["shift"], rec["technician"], rec["timeStart"], rec["timeFinish"],
                    rec["downtime"], rec.get("remarks", ""), now_iso(),
                ),
            )

    if conn.execute("SELECT COUNT(*) FROM reference_items").fetchone()[0] == 0:
        for cat, values in [("machine", MACHINES)]:
            for v in values:
                conn.execute(
                    "INSERT OR IGNORE INTO reference_items (id, category, value, unit) VALUES (?,?,?,?)",
                    ("ref-" + uuid.uuid4().hex[:10], cat, v, DEFAULT_UNIT_NAME),
                )
        for cat, values in [("shift", SHIFTS), ("fault", FAULT_CATEGORIES),
                             ("technician", TECHNICIANS), ("complaint", COMPLAINT_REFERENCES),
                             ("notification", NOTIFICATION_TYPES),
                             ("deviceDetail", DEVICE_DETAILS), ("deviceSubCat", DEVICE_SUB_CATEGORIES)]:
            for v in values:
                conn.execute(
                    "INSERT OR IGNORE INTO reference_items (id, category, value, unit) VALUES (?,?,?,?)",
                    ("ref-" + uuid.uuid4().hex[:10], cat, v, ""),
                )

    # One-time migration: seed Unit-02 (D12) data if not already present.
    # Gated on the unit's existence so admin edits/deletions afterward are never overwritten.
    if conn.execute("SELECT COUNT(*) FROM units WHERE name=?", (UNIT2_NAME,)).fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO units (id, name, createdAt) VALUES (?,?,?)",
            ("unit-" + uuid.uuid4().hex[:10], UNIT2_NAME, now_iso()),
        )

        for rec in SEED_RECORDS_UNIT2:
            conn.execute(
                """INSERT INTO records
                   (id, date, complaintReference, ticketNo, unit, machine, machineNo, deviceDetail, deviceSubCat,
                    faultCategory, reason, actionTaken, shift, technician,
                    timeStart, timeFinish, downtime, remarks, createdAt)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    rec["id"], rec["date"], rec.get("complaintReference", ""), rec.get("ticketNo", ""),
                    UNIT2_NAME, rec["machine"], rec.get("machineNo", ""),
                    rec.get("deviceDetail", ""), rec.get("deviceSubCat", ""),
                    rec["faultCategory"], rec.get("reason", ""), rec.get("actionTaken", ""),
                    rec["shift"], rec["technician"], rec["timeStart"], rec["timeFinish"],
                    rec["downtime"], rec.get("remarks", ""), now_iso(),
                ),
            )

        for v in MACHINES_UNIT2:
            conn.execute(
                "INSERT OR IGNORE INTO reference_items (id, category, value, unit) VALUES (?,?,?,?)",
                ("ref-" + uuid.uuid4().hex[:10], "machine", v, UNIT2_NAME),
            )

        for cat, values in [("shift", SHIFTS_UNIT2), ("fault", FAULT_CATEGORIES_UNIT2),
                             ("technician", TECHNICIANS_UNIT2), ("complaint", COMPLAINT_REFERENCES_UNIT2),
                             ("notification", NOTIFICATION_TYPES_UNIT2),
                             ("deviceDetail", DEVICE_DETAILS_UNIT2), ("deviceSubCat", DEVICE_SUB_CATEGORIES_UNIT2)]:
            for v in values:
                conn.execute(
                    "INSERT OR IGNORE INTO reference_items (id, category, value, unit) VALUES (?,?,?,?)",
                    ("ref-" + uuid.uuid4().hex[:10], cat, v, ""),
                )

    created_admin = False
    if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        conn.execute(
            "INSERT INTO users (id, username, password_hash, role, can_add_data, can_edit_delete, createdAt) VALUES (?,?,?,?,?,?,?)",
            ("u-" + uuid.uuid4().hex[:10], "admin",
             generate_password_hash("admin123"), "admin", 1, 1, now_iso()),
        )
        created_admin = True

    conn.commit()
    conn.close()
    return created_admin


# ---------------------------------------------------------------- auth helpers

def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    row = get_db().execute(
        "SELECT id, username, role, can_add_data, can_edit_delete FROM users WHERE id=?", (uid,)
    ).fetchone()
    if not row:
        return None
    user = dict(row)
    user["can_add_data"] = bool(user["can_add_data"]) or user["role"] == "admin"
    user["can_edit_delete"] = bool(user["can_edit_delete"]) or user["role"] == "admin"
    return user


@app.context_processor
def inject_user():
    return {"current_user": current_user()}


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_user():
            if request.path.startswith("/api/"):
                return jsonify({"error": "Login required."}), 401
            return redirect(url_for("login_page", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Login required."}), 401
            return redirect(url_for("login_page", next=request.path))
        if user["role"] != "admin":
            if request.path.startswith("/api/"):
                return jsonify({"error": "Only admin is allowed."}), 403
            flash("Only admin can access this page.", "error")
            return redirect(url_for("dashboard_page"))
        return view(*args, **kwargs)
    return wrapped


def add_data_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Login required."}), 401
            return redirect(url_for("login_page", next=request.path))
        if not user["can_add_data"]:
            if request.path.startswith("/api/"):
                return jsonify({"error": "You do not have data entry permission."}), 403
            flash("You do not have data entry permission.", "error")
            return redirect(url_for("dashboard_page"))
        return view(*args, **kwargs)
    return wrapped


def edit_delete_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Login required."}), 401
            return redirect(url_for("login_page", next=request.path))
        if not user["can_edit_delete"]:
            return jsonify({"error": "You do not have edit/delete permission."}), 403
        return view(*args, **kwargs)
    return wrapped


# ---------------------------------------------------------------- misc helpers

def time_to_minutes(t):
    if not t:
        return None
    try:
        h, m = t.split(":")
        return int(h) * 60 + int(m)
    except ValueError:
        return None


def compute_downtime(start, finish):
    s, f = time_to_minutes(start), time_to_minutes(finish)
    if s is None or f is None:
        return ""
    diff = f - s
    if diff < 0:
        diff += 24 * 60
    return f"{diff // 60:02d}:{diff % 60:02d}"


def downtime_to_minutes(dt):
    if not dt:
        return 0
    try:
        h, m = dt.split(":")
        return int(h) * 60 + int(m)
    except ValueError:
        return 0


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


def _as_list(v):
    """Normalizes a filter value that may be a single string, a list of
    strings, or None — every categorical filter now supports selecting
    multiple values at once (multi-select), while staying backward
    compatible with old single-value callers."""
    if v is None or v == "":
        return None
    if isinstance(v, (list, tuple, set)):
        v = [x for x in v if x not in (None, "")]
        return v or None
    return [v]


def normalize_technicians(value):
    """A breakdown can be attended by more than one technician. We store them
    as a single ', '-joined string in the existing `technician` column (no
    schema change). Accepts a list or a comma/'&'/'+'-separated string and
    returns a clean, de-duplicated ', '-joined string preserving order."""
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        parts = [str(x).strip() for x in value]
    else:
        parts = re.split(r"[,&+/]| and ", str(value))
        parts = [p.strip() for p in parts]
    seen, out = set(), []
    for p in parts:
        if p and p.lower() not in seen:
            seen.add(p.lower())
            out.append(p)
    return ", ".join(out)


def split_technicians(value):
    """Splits a stored technician string back into the individual names, so
    stats and reports can attribute a job to EACH technician who attended."""
    if not value:
        return []
    return [p.strip() for p in str(value).split(",") if p.strip()]


def query_records(start=None, end=None, unit=None, machine=None, machineNo=None, shift=None, technician=None, fault=None, complaintReference=None, notificationType=None, hour=None, q=None):
    db = get_db()
    sql = "SELECT * FROM records WHERE 1=1"
    params = []

    def add_in_clause(column, value):
        nonlocal sql
        vals = _as_list(value)
        if not vals:
            return
        placeholders = ",".join(["?"] * len(vals))
        sql += f" AND {column} IN ({placeholders})"
        params.extend(vals)

    if start:
        sql += " AND date >= ?"
        params.append(start)
    if end:
        sql += " AND date <= ?"
        params.append(end)
    add_in_clause("unit", unit)
    add_in_clause("machine", machine)
    add_in_clause("machineNo", machineNo)
    add_in_clause("shift", shift)
    # technician is stored as a ", "-joined list, so match records where ANY of
    # the selected technicians appears in that list (delimiter-safe LIKE).
    tech_vals = _as_list(technician)
    if tech_vals:
        clauses = []
        for t in tech_vals:
            clauses.append("(', ' || technician || ', ') LIKE ?")
            params.append(f"%, {t}, %")
        sql += " AND (" + " OR ".join(clauses) + ")"
    add_in_clause("faultCategory", fault)
    add_in_clause("complaintReference", complaintReference)
    add_in_clause("notificationType", notificationType)
    hours = _as_list(hour)
    if hours:
        placeholders = ",".join(["?"] * len(hours))
        sql += f" AND substr(timeStart, 1, 2) IN ({placeholders})"
        params.extend(str(h).zfill(2) for h in hours)
    sql += " ORDER BY date DESC, createdAt DESC"
    rows = [row_to_dict(r) for r in db.execute(sql, params).fetchall()]
    if q:
        ql = q.lower()
        def hay(r):
            # Columns added by a later migration (e.g. orderNo) are NULL on rows
            # created before that migration, and .get() returns that None — which
            # would blow up the join. Coerce every field to a string first.
            fields = ["machine", "faultCategory", "technician", "reason",
                      "actionTaken", "complaintReference", "notificationType", "ticketNo", "orderNo",
                      "unit", "machineNo", "deviceDetail", "deviceSubCat", "remarks"]
            return " ".join(str(r.get(f) or "") for f in fields).lower()
        rows = [r for r in rows if ql in hay(r)]
    return rows


def parse_filters(args):
    def get_multi(key):
        vals = args.getlist(key)
        return vals if vals else None

    return dict(
        start=args.get("start") or None,
        end=args.get("end") or None,
        unit=get_multi("unit"),
        machine=get_multi("machine"),
        machineNo=get_multi("machineNo"),
        shift=get_multi("shift"),
        technician=get_multi("technician"),
        fault=get_multi("fault"),
        complaintReference=get_multi("complaintReference"),
        notificationType=get_multi("notificationType"),
        hour=get_multi("hour"),
        q=args.get("q") or None,
    )


def compute_stats(rows):
    total = len(rows)
    total_min = sum(downtime_to_minutes(r["downtime"]) for r in rows)
    avg_min = (total_min / total) if total else 0

    by_machine, by_fault, by_shift, by_date, by_tech, by_unit, by_device = {}, {}, {}, {}, {}, {}, {}
    by_weekday_shift = {}
    by_hour = {}
    WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    for r in rows:
        m_name = r["machine"] or "Unknown"
        m_no = (r.get("machineNo") or "").strip()
        m = f"{m_name} #{m_no}" if m_no else m_name
        mins = downtime_to_minutes(r["downtime"])
        by_machine[m] = by_machine.get(m, 0) + mins
        f = r["faultCategory"] or "Unknown"
        by_fault[f] = by_fault.get(f, 0) + 1
        s = r["shift"] or "?"
        by_shift[s] = by_shift.get(s, 0) + 1
        d = r["date"] or "?"
        by_date[d] = by_date.get(d, 0) + mins
        techs = split_technicians(r["technician"]) or ["Unknown"]
        for t in techs:
            by_tech[t] = by_tech.get(t, 0) + 1
        u = r.get("unit") or "Unknown"
        by_unit[u] = by_unit.get(u, 0) + mins
        dd = r.get("deviceDetail") or "Unspecified"
        by_device[dd] = by_device.get(dd, 0) + 1
        if r["date"]:
            try:
                wd = WEEKDAYS[datetime.strptime(r["date"], "%Y-%m-%d").weekday()]
                key = (wd, s)
                by_weekday_shift[key] = by_weekday_shift.get(key, 0) + mins
            except ValueError:
                pass
        ts = r.get("timeStart") or ""
        if ":" in ts:
            try:
                hr = int(ts.split(":")[0])
                if 0 <= hr <= 23:
                    by_hour[hr] = by_hour.get(hr, 0) + mins
            except ValueError:
                pass

    machine_data = sorted(by_machine.items(), key=lambda x: -x[1])
    fault_data = sorted(by_fault.items(), key=lambda x: -x[1])
    shift_data = sorted(by_shift.items())
    trend_data = sorted(by_date.items())
    tech_data = sorted(by_tech.items(), key=lambda x: -x[1])
    unit_data = sorted(by_unit.items(), key=lambda x: -x[1])
    device_data = sorted(by_device.items(), key=lambda x: -x[1])
    top_machine = machine_data[0][0] if machine_data else "\u2014"
    top_fault = fault_data[0][0] if fault_data else "\u2014"
    top_shift = max(by_shift.items(), key=lambda x: x[1])[0] if by_shift else "\u2014"

    shifts_present = sorted({k[1] for k in by_weekday_shift})
    heatmap = {
        "days": WEEKDAYS,
        "shifts": shifts_present,
        "values": [[round(by_weekday_shift.get((wd, sh), 0)) for wd in WEEKDAYS] for sh in shifts_present],
    }
    hour_data = [{"hour": h, "minutes": round(by_hour.get(h, 0))} for h in range(24)]

    return {
        "total": total, "totalMinutes": round(total_min), "avgMinutes": round(avg_min, 1),
        "topMachine": top_machine, "topFault": top_fault, "topShift": top_shift,
        "distinctMachines": len(by_machine), "distinctFaults": len(by_fault),
        "distinctTechnicians": len(by_tech), "distinctUnits": len(by_unit),
        "machineData": [{"name": n, "minutes": round(v)} for n, v in machine_data],
        "faultData": [{"name": n, "count": v} for n, v in fault_data],
        "shiftData": [{"name": n, "count": v} for n, v in shift_data],
        "trendData": [{"date": d, "minutes": round(v)} for d, v in trend_data],
        "techData": [{"name": n, "count": v} for n, v in tech_data],
        "unitData": [{"name": n, "minutes": round(v)} for n, v in unit_data],
        "deviceData": [{"name": n, "count": v} for n, v in device_data],
        "heatmap": heatmap,
        "hourData": hour_data,
    }


def compute_grouped_by_unit(rows, name_fn, mode="count", sort="value", explode=False):
    """Groups records by (unit, dimension-value) so an Excel breakdown sheet can
    show every unit/department's numbers as separate rows, instead of merging
    all units together into one combined figure per fault/machine/etc.

    sort="value" (default) orders each unit's rows by their number, biggest
    first. sort="name" orders by the dimension value itself (ascending) — used
    by the day-wise sheet so dates come out as a proper chronological series.

    explode=True lets name_fn return a LIST of values for one record (e.g. all
    the technicians who attended a breakdown), so each is counted separately."""
    grouped = {}
    for r in rows:
        u = r.get("unit") or "Unknown"
        nv = name_fn(r)
        values = nv if (explode and isinstance(nv, list)) else [nv]
        for v in values:
            key = (u, v)
            if mode == "minutes":
                grouped[key] = grouped.get(key, 0) + downtime_to_minutes(r["downtime"])
            else:
                grouped[key] = grouped.get(key, 0) + 1

    if sort == "name":
        items = sorted(grouped.items(), key=lambda kv: (kv[0][0], kv[0][1]))
    else:
        items = sorted(grouped.items(), key=lambda kv: (kv[0][0], -kv[1]))
    if mode == "minutes":
        return [[u, name, round(v)] for (u, name), v in items]
    return [[u, name, v] for (u, name), v in items]


def _machine_label(r):
    m_name = r["machine"] or "Unknown"
    m_no = (r.get("machineNo") or "").strip()
    return f"{m_name} #{m_no}" if m_no else m_name



# ---------------------------------------------------------------- auth pages

@app.route("/login", methods=["GET", "POST"])
def login_page():
    if current_user():
        return redirect(url_for("dashboard_page"))
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        row = get_db().execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if row and check_password_hash(row["password_hash"], password):
            session["user_id"] = row["id"]
            flash(f"Welcome, {row['username']}!", "success")
            nxt = request.args.get("next") or url_for("dashboard_page")
            return redirect(nxt)
        flash("Incorrect username or password.", "error")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    flash("You have been logged out.", "success")
    return redirect(url_for("login_page"))


# ---------------------------------------------------------------- pages

@app.route("/")
@login_required
def dashboard_page():
    return render_template("dashboard.html", active="dashboard")


@app.route("/logs")
@login_required
def logs_page():
    return render_template("logs.html", active="logs")


@app.route("/add")
@add_data_required
def add_data_page():
    return render_template("add_data.html", active="add")


@app.route("/reports")
@login_required
def reports_page():
    return render_template("reports.html", active="reports")


@app.route("/performance")
@login_required
def performance_page():
    return render_template("performance.html", active="performance")


@app.route("/users")
@admin_required
def users_page():
    return render_template("users.html", active="users")


@app.route("/account")
@login_required
def account_page():
    return render_template("account.html", active="account")


@app.route("/settings")
@admin_required
def settings_page():
    return render_template("settings.html", active="settings")


# ---------------------------------------------------------------- API: reference lists

_UNIT_SCOPED_CATEGORIES = ("machine",)
_VALID_CATEGORIES = ("machine", "shift", "fault", "technician", "complaint", "notification", "deviceDetail", "deviceSubCat")


@app.route("/api/reference")
@login_required
def api_reference():
    db = get_db()
    # Accepts repeated ?unit= params so a multi-unit selection returns the
    # UNION of those units' machines, not just the first one's.
    units = [u for u in request.args.getlist("unit") if u]

    def vals(cat):
        if cat in _UNIT_SCOPED_CATEGORIES and units:
            placeholders = ",".join(["?"] * len(units))
            rows = db.execute(
                f"SELECT DISTINCT value FROM reference_items WHERE category=? AND unit IN ({placeholders}) ORDER BY value",
                (cat, *units))
        elif cat in _UNIT_SCOPED_CATEGORIES:
            rows = db.execute(
                "SELECT DISTINCT value FROM reference_items WHERE category=? ORDER BY value", (cat,))
        else:
            rows = db.execute(
                "SELECT value FROM reference_items WHERE category=? ORDER BY value", (cat,))
        return [r["value"] for r in rows]

    return jsonify({
        "machines": vals("machine"), "shifts": vals("shift"),
        "faultCategories": vals("fault"), "technicians": vals("technician"),
        "complaintReferences": vals("complaint"),
        "notificationTypes": vals("notification"),
        "deviceDetails": vals("deviceDetail"), "deviceSubCategories": vals("deviceSubCat"),
    })


@app.route("/api/machine-numbers")
@login_required
def api_machine_numbers():
    machines = request.args.getlist("machine")
    units = request.args.getlist("unit")
    if not machines:
        return jsonify([])

    db = get_db()
    m_placeholders = ",".join(["?"] * len(machines))
    sql = f"SELECT DISTINCT machineNo FROM records WHERE machine IN ({m_placeholders}) AND machineNo IS NOT NULL AND machineNo != ''"
    params = list(machines)
    if units:
        u_placeholders = ",".join(["?"] * len(units))
        sql += f" AND unit IN ({u_placeholders})"
        params.extend(units)
    rows = db.execute(sql, params).fetchall()
    values = [r["machineNo"] for r in rows]

    def sort_key(v):
        try:
            return (0, int(v))
        except ValueError:
            return (1, v)

    return jsonify(sorted(values, key=sort_key))


DEFAULT_DAILY_HOURS = 8
_MONTH_LABELS = ["", "January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November", "December"]


def get_technician_hours_map():
    """Returns { technician_name: daily_hours } for every known technician,
    defaulting to 8 hours where nothing has been configured."""
    db = get_db()
    techs = [r["value"] for r in db.execute(
        "SELECT DISTINCT value FROM reference_items WHERE category='technician' ORDER BY value")]
    stored = {r["technician"]: r["daily_hours"] for r in db.execute(
        "SELECT technician, daily_hours FROM technician_hours")}
    result = {t: float(stored.get(t, DEFAULT_DAILY_HOURS)) for t in techs}
    # include any technician that has stored hours but is no longer in the ref list
    for t, h in stored.items():
        result.setdefault(t, float(h))
    return result


def get_technician_day_hours(technician, year):
    """Returns { 'YYYY-MM-DD': hours } of any per-day overrides for the year."""
    db = get_db()
    rows = db.execute(
        "SELECT date, daily_hours FROM technician_day_hours WHERE technician=? AND date LIKE ?",
        (technician, f"{year}-%"))
    return {r["date"]: float(r["daily_hours"]) for r in rows}


def get_technician_day_hours_range(technician, start=None, end=None):
    """Per-day hour overrides for a technician within an optional date range."""
    db = get_db()
    if start and end:
        rows = db.execute(
            "SELECT date, daily_hours FROM technician_day_hours WHERE technician=? AND date BETWEEN ? AND ?",
            (technician, start, end))
    else:
        rows = db.execute(
            "SELECT date, daily_hours FROM technician_day_hours WHERE technician=?", (technician,))
    return {r["date"]: float(r["daily_hours"]) for r in rows}


def compute_technician_report(technician, start=None, end=None, units=None):
    """Range-based performance breakdown for one technician (used by the
    Performance Excel report). Works over any date range — not just a single
    year — and returns per-day rows, a month-by-month rollup and a summary,
    each day using its own working hours (per-day override or the default)."""
    default_hours = get_technician_hours_map().get(technician, DEFAULT_DAILY_HOURS)
    day_overrides = get_technician_day_hours_range(technician, start, end)

    def hours_for(d):
        return day_overrides.get(d, default_hours)

    rows = query_records(start=start, end=end, technician=[technician], unit=units)
    daily = {}
    for r in rows:
        d = r.get("date") or ""
        if not d:
            continue
        mins = downtime_to_minutes(r["downtime"])
        if d not in daily:
            daily[d] = [0, 0]
        daily[d][0] += mins
        daily[d][1] += 1

    def eff_for_dates(minutes, dates):
        avail = sum(hours_for(d) * 60 for d in dates)
        return round((minutes / avail) * 100, 1) if avail else 0.0

    days = []
    for d in sorted(daily.keys()):
        mins, cnt = daily[d]
        days.append({"date": d, "breakdowns": cnt, "minutes": mins,
                     "hours": hours_for(d), "efficiency": eff_for_dates(mins, [d])})

    by_month = {}
    for d, (mins, cnt) in daily.items():
        key = d[:7]
        if key not in by_month:
            by_month[key] = [0, set()]
        by_month[key][0] += mins
        by_month[key][1].add(d)
    months = []
    for key in sorted(by_month.keys()):
        mins, dates = by_month[key]
        months.append({"month": key, "daysWorked": len(dates), "minutes": mins,
                       "efficiency": eff_for_dates(mins, dates)})

    all_dates = list(daily.keys())
    total_minutes = sum(v[0] for v in daily.values())
    summary = {
        "minutes": total_minutes,
        "daysWorked": len(all_dates),
        "efficiency": eff_for_dates(total_minutes, all_dates),
        "hoursAvailable": round(sum(hours_for(d) for d in all_dates), 1),
        "defaultHours": default_hours,
    }
    return {"technician": technician, "days": days, "months": months, "summary": summary}


def compute_technician_performance(technician, year, month=None, units=None):
    """Builds a day-by-day (and month-by-month) efficiency breakdown for one
    technician. Efficiency = minutes worked / (working hours that day x 60).
    Each day uses its own hours: the per-day override if one is set, otherwise
    the technician's default daily hours. A breakdown attended by several
    technicians credits its full downtime to each of them (same as the
    Technician Workload chart)."""
    default_hours = get_technician_hours_map().get(technician, DEFAULT_DAILY_HOURS)
    day_overrides = get_technician_day_hours(technician, year)

    def hours_for(d):
        return day_overrides.get(d, default_hours)

    start = f"{year}-01-01"
    end = f"{year}-12-31"
    rows = query_records(start=start, end=end, technician=[technician], unit=units)

    daily = {}  # date -> [minutes, breakdown_count]
    for r in rows:
        d = r.get("date") or ""
        if not d:
            continue
        mins = downtime_to_minutes(r["downtime"])
        if d not in daily:
            daily[d] = [0, 0]
        daily[d][0] += mins
        daily[d][1] += 1

    def eff_for_dates(minutes, dates):
        # available minutes = sum of each day's own working hours x 60
        avail = sum(hours_for(d) * 60 for d in dates)
        return round((minutes / avail) * 100, 1) if avail else 0.0

    # ----- month view: one row per active day in that month -----
    days_list = []
    if month:
        mm = f"{int(month):02d}"
        for d in sorted(daily.keys()):
            if d[5:7] == mm:
                mins, cnt = daily[d]
                days_list.append({
                    "date": d, "breakdowns": cnt, "minutes": mins,
                    "hours": hours_for(d),
                    "isOverride": d in day_overrides,
                    "efficiency": eff_for_dates(mins, [d]),
                })

    # ----- month-by-month rollup for the year -----
    months_list = []
    by_month = {}  # m -> [minutes, set(dates)]
    for d, (mins, cnt) in daily.items():
        m = int(d[5:7])
        if m not in by_month:
            by_month[m] = [0, set()]
        by_month[m][0] += mins
        by_month[m][1].add(d)
    for m in sorted(by_month.keys()):
        mins, dates = by_month[m]
        months_list.append({
            "month": m, "monthName": _MONTH_LABELS[m],
            "daysWorked": len(dates), "minutes": mins,
            "efficiency": eff_for_dates(mins, dates),
        })

    # ----- summary for the selected scope -----
    if month:
        mm = f"{int(month):02d}"
        scope_dates = [d for d in daily if d[5:7] == mm]
        scope_label = f"{_MONTH_LABELS[int(month)]} {year}"
    else:
        scope_dates = list(daily.keys())
        scope_label = str(year)
    scope_minutes = sum(daily[d][0] for d in scope_dates)
    days_worked = len(scope_dates)
    summary = {
        "minutes": scope_minutes,
        "daysWorked": days_worked,
        "efficiency": eff_for_dates(scope_minutes, scope_dates),
        "hoursAvailable": round(sum(hours_for(d) for d in scope_dates), 1),
        "label": scope_label,
    }

    return {
        "technician": technician,
        "dailyHours": default_hours,
        "scope": "month" if month else "year",
        "days": days_list,
        "months": months_list,
        "summary": summary,
    }


@app.route("/api/technician-hours")
@login_required
def api_technician_hours():
    return jsonify(get_technician_hours_map())


@app.route("/api/technician-hours", methods=["POST"])
@admin_required
def api_technician_hours_set():
    data = request.get_json(force=True) or {}
    tech = (data.get("technician") or "").strip()
    if not tech:
        return jsonify({"error": "Technician is required."}), 400
    try:
        hours = float(data.get("dailyHours"))
    except (TypeError, ValueError):
        return jsonify({"error": "Daily hours must be a number."}), 400
    if hours <= 0 or hours > 24:
        return jsonify({"error": "Daily hours must be between 1 and 24."}), 400
    db = get_db()
    db.execute(
        """INSERT INTO technician_hours (technician, daily_hours, updatedAt) VALUES (?,?,?)
           ON CONFLICT(technician) DO UPDATE SET daily_hours=excluded.daily_hours, updatedAt=excluded.updatedAt""",
        (tech, hours, now_iso()),
    )
    db.commit()
    return jsonify({"technician": tech, "dailyHours": hours})


@app.route("/api/technician-day-hours", methods=["POST"])
@admin_required
def api_technician_day_hours_set():
    """Sets (or clears) the working hours for one technician on one specific
    date, overriding their default for that day only."""
    data = request.get_json(force=True) or {}
    tech = (data.get("technician") or "").strip()
    date = (data.get("date") or "").strip()
    if not tech or not date:
        return jsonify({"error": "Technician and date are required."}), 400
    db = get_db()
    raw = data.get("dailyHours")
    # empty value clears the override (revert that day to the default)
    if raw is None or raw == "":
        db.execute("DELETE FROM technician_day_hours WHERE technician=? AND date=?", (tech, date))
        db.commit()
        return jsonify({"technician": tech, "date": date, "dailyHours": None, "cleared": True})
    try:
        hours = float(raw)
    except (TypeError, ValueError):
        return jsonify({"error": "Daily hours must be a number."}), 400
    if hours <= 0 or hours > 24:
        return jsonify({"error": "Daily hours must be between 1 and 24."}), 400
    db.execute(
        """INSERT INTO technician_day_hours (technician, date, daily_hours, updatedAt) VALUES (?,?,?,?)
           ON CONFLICT(technician, date) DO UPDATE SET daily_hours=excluded.daily_hours, updatedAt=excluded.updatedAt""",
        (tech, date, hours, now_iso()),
    )
    db.commit()
    return jsonify({"technician": tech, "date": date, "dailyHours": hours})


@app.route("/api/technician-performance")
@login_required
def api_technician_performance():
    technician = (request.args.get("technician") or "").strip()
    if not technician:
        return jsonify({"error": "Technician is required."}), 400
    try:
        year = int(request.args.get("year") or datetime.now().year)
    except ValueError:
        year = datetime.now().year
    month = request.args.get("month") or None
    if month:
        try:
            month = int(month)
        except ValueError:
            month = None
    units = [u for u in request.args.getlist("unit") if u] or None
    return jsonify(compute_technician_performance(technician, year, month, units))


@app.route("/api/technician-day-detail")
@login_required
def api_technician_day_detail():
    """Lists the individual breakdowns a technician attended on one specific
    date, so the performance page can show where that day's time actually went
    (which machine, which fault, how long each job took)."""
    technician = (request.args.get("technician") or "").strip()
    date = (request.args.get("date") or "").strip()
    if not technician or not date:
        return jsonify({"error": "Technician and date are required."}), 400
    units = [u for u in request.args.getlist("unit") if u] or None
    rows = query_records(start=date, end=date, technician=[technician], unit=units)
    rows.sort(key=lambda r: r.get("timeStart") or "")
    items = [{
        "unit": r.get("unit", ""),
        "machine": r.get("machine", ""),
        "machineNo": r.get("machineNo", ""),
        "faultCategory": r.get("faultCategory", ""),
        "deviceDetail": r.get("deviceDetail", ""),
        "shift": r.get("shift", ""),
        "timeStart": r.get("timeStart", ""),
        "timeFinish": r.get("timeFinish", ""),
        "downtime": r.get("downtime", ""),
        "minutes": downtime_to_minutes(r.get("downtime", "")),
        "reason": r.get("reason", ""),
        "actionTaken": r.get("actionTaken", ""),
    } for r in rows]
    total_minutes = sum(i["minutes"] for i in items)
    return jsonify({
        "technician": technician, "date": date,
        "items": items, "count": len(items), "totalMinutes": total_minutes,
    })


@app.route("/api/reference/<category>", methods=["POST"])
@admin_required
def api_reference_add(category):
    if category not in _VALID_CATEGORIES:
        return jsonify({"error": "Invalid category."}), 400
    data = request.get_json(force=True) or {}
    value = data.get("value", "").strip()
    unit = data.get("unit", "").strip() if category in _UNIT_SCOPED_CATEGORIES else ""
    if not value:
        return jsonify({"error": "Value cannot be empty."}), 400
    if category in _UNIT_SCOPED_CATEGORIES and not unit:
        return jsonify({"error": "Please select a unit."}), 400
    db = get_db()
    try:
        db.execute("INSERT INTO reference_items (id, category, value, unit) VALUES (?,?,?,?)",
                   ("ref-" + uuid.uuid4().hex[:10], category, value, unit))
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "This value already exists."}), 400
    return jsonify({"ok": True, "value": value}), 201


@app.route("/api/reference/<category>/<value>", methods=["DELETE"])
@admin_required
def api_reference_delete(category, value):
    unit = request.args.get("unit", "")
    db = get_db()
    if category in _UNIT_SCOPED_CATEGORIES:
        db.execute("DELETE FROM reference_items WHERE category=? AND value=? AND unit=?", (category, value, unit))
    else:
        db.execute("DELETE FROM reference_items WHERE category=? AND value=?", (category, value))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- API: records

@app.route("/api/records", methods=["GET"])
@login_required
def api_list_records():
    rows = query_records(**parse_filters(request.args))
    return jsonify(rows)


@app.route("/api/records", methods=["POST"])
@add_data_required
def api_create_record():
    data = request.get_json(force=True) or {}
    required = ["date", "unit", "machine", "faultCategory", "shift", "technician", "timeStart", "timeFinish"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    rec = {
        "id": "r-" + uuid.uuid4().hex[:10],
        "date": data["date"], "complaintReference": data.get("complaintReference", ""),
        "notificationType": data.get("notificationType", ""),
        "ticketNo": data.get("ticketNo", ""), "orderNo": data.get("orderNo", ""), "unit": data["unit"],
        "machine": data["machine"], "machineNo": data.get("machineNo", ""),
        "deviceDetail": data.get("deviceDetail", ""), "deviceSubCat": data.get("deviceSubCat", ""),
        "faultCategory": data["faultCategory"], "reason": data.get("reason", ""),
        "actionTaken": data.get("actionTaken", ""), "shift": data["shift"],
        "technician": normalize_technicians(data["technician"]), "timeStart": data["timeStart"], "timeFinish": data["timeFinish"],
        "downtime": compute_downtime(data["timeStart"], data["timeFinish"]),
        "remarks": data.get("remarks", ""), "createdAt": now_iso(),
    }
    db = get_db()
    db.execute(
        """INSERT INTO records
           (id, date, complaintReference, notificationType, ticketNo, orderNo, unit, machine, machineNo, deviceDetail, deviceSubCat,
            faultCategory, reason, actionTaken, shift, technician,
            timeStart, timeFinish, downtime, remarks, createdAt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        tuple(rec[k] for k in ["id", "date", "complaintReference", "notificationType", "ticketNo", "orderNo", "unit", "machine", "machineNo",
                                "deviceDetail", "deviceSubCat", "faultCategory", "reason", "actionTaken",
                                "shift", "technician", "timeStart", "timeFinish", "downtime", "remarks", "createdAt"]),
    )
    db.commit()
    return jsonify(rec), 201


# ---------------------------------------------------------------- API: units

@app.route("/api/units", methods=["GET"])
@login_required
def api_list_units():
    db = get_db()
    rows = db.execute("SELECT id, name, createdAt FROM units ORDER BY name").fetchall()
    result = []
    for r in rows:
        d = row_to_dict(r)
        d["recordCount"] = db.execute(
            "SELECT COUNT(*) FROM records WHERE unit=?", (d["name"],)).fetchone()[0]
        d["machineCount"] = db.execute(
            "SELECT COUNT(*) FROM reference_items WHERE category='machine' AND unit=?", (d["name"],)).fetchone()[0]
        result.append(d)
    return jsonify(result)


@app.route("/api/units", methods=["POST"])
@admin_required
def api_create_unit():
    name = (request.get_json(force=True) or {}).get("name", "").strip()
    if not name:
        return jsonify({"error": "Unit name is required."}), 400
    db = get_db()
    try:
        uid = "unit-" + uuid.uuid4().hex[:10]
        db.execute("INSERT INTO units (id, name, createdAt) VALUES (?,?,?)", (uid, name, now_iso()))
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "This unit already exists."}), 400
    return jsonify({"id": uid, "name": name}), 201


@app.route("/api/units/<unit_id>", methods=["DELETE"])
@admin_required
def api_delete_unit(unit_id):
    db = get_db()
    unit_count = db.execute("SELECT COUNT(*) FROM units").fetchone()[0]
    if unit_count <= 1:
        return jsonify({"error": "The last unit cannot be deleted."}), 400
    db.execute("DELETE FROM units WHERE id=?", (unit_id,))
    db.commit()
    return jsonify({"deleted": unit_id})


@app.route("/api/records/<rec_id>", methods=["PUT"])
@edit_delete_required
def api_update_record(rec_id):
    db = get_db()
    existing = db.execute("SELECT * FROM records WHERE id=?", (rec_id,)).fetchone()
    if not existing:
        return jsonify({"error": "Record not found."}), 404

    data = request.get_json(force=True) or {}
    required = ["date", "unit", "machine", "faultCategory", "shift", "technician", "timeStart", "timeFinish"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400

    fields = {
        "date": data["date"], "complaintReference": data.get("complaintReference", ""),
        "notificationType": data.get("notificationType", ""),
        "ticketNo": data.get("ticketNo", ""), "orderNo": data.get("orderNo", ""), "unit": data["unit"],
        "machine": data["machine"], "machineNo": data.get("machineNo", ""),
        "deviceDetail": data.get("deviceDetail", ""), "deviceSubCat": data.get("deviceSubCat", ""),
        "faultCategory": data["faultCategory"], "reason": data.get("reason", ""),
        "actionTaken": data.get("actionTaken", ""), "shift": data["shift"],
        "technician": normalize_technicians(data["technician"]), "timeStart": data["timeStart"], "timeFinish": data["timeFinish"],
        "downtime": compute_downtime(data["timeStart"], data["timeFinish"]),
        "remarks": data.get("remarks", ""),
    }
    db.execute(
        """UPDATE records SET
           date=?, complaintReference=?, notificationType=?, ticketNo=?, orderNo=?, unit=?, machine=?, machineNo=?,
           deviceDetail=?, deviceSubCat=?, faultCategory=?, reason=?, actionTaken=?,
           shift=?, technician=?, timeStart=?, timeFinish=?, downtime=?, remarks=?
           WHERE id=?""",
        (
            fields["date"], fields["complaintReference"], fields["notificationType"], fields["ticketNo"], fields["orderNo"], fields["unit"],
            fields["machine"], fields["machineNo"], fields["deviceDetail"], fields["deviceSubCat"],
            fields["faultCategory"], fields["reason"], fields["actionTaken"], fields["shift"],
            fields["technician"], fields["timeStart"], fields["timeFinish"], fields["downtime"],
            fields["remarks"], rec_id,
        ),
    )
    db.commit()
    fields["id"] = rec_id
    return jsonify(fields)


@app.route("/api/records/<rec_id>", methods=["DELETE"])
@edit_delete_required
def api_delete_record(rec_id):
    db = get_db()
    db.execute("DELETE FROM records WHERE id = ?", (rec_id,))
    db.commit()
    return jsonify({"deleted": rec_id})


# ---------------------------------------------------------------- API: dashboard / reports

def zero_fill_trend(trend_data, start, end, max_days=400):
    """Fills in every date between start and end (inclusive) with 0 downtime
    where no breakdown was recorded, so day-wise charts never skip empty days."""
    if not start or not end:
        return trend_data
    try:
        start_d = datetime.strptime(start, "%Y-%m-%d").date()
        end_d = datetime.strptime(end, "%Y-%m-%d").date()
    except ValueError:
        return trend_data
    if start_d > end_d or (end_d - start_d).days > max_days:
        return trend_data

    existing = {d["date"]: d["minutes"] for d in trend_data}
    filled = []
    d = start_d
    while d <= end_d:
        iso = d.isoformat()
        filled.append({"date": iso, "minutes": existing.get(iso, 0)})
        d += timedelta(days=1)
    return filled


@app.route("/api/stats")
@login_required
def api_stats():
    filters = parse_filters(request.args)
    rows = query_records(**filters)
    stats = compute_stats(rows)
    stats["trendData"] = zero_fill_trend(stats["trendData"], filters.get("start"), filters.get("end"))
    stats["trendData"] = [
        {"date": d["date"][5:] if len(d["date"]) >= 10 else d["date"], "minutes": d["minutes"]}
        for d in stats["trendData"]
    ]
    return jsonify(stats)



@app.route("/api/reports/export")
@login_required
def api_reports_export():
    filters = parse_filters(request.args)
    rows = query_records(**filters)
    stats = compute_stats(rows)
    stats["trendData"] = zero_fill_trend(stats["trendData"], filters.get("start"), filters.get("end"))

    wb = Workbook()
    _build_summary_sheet(wb, stats, filters)

    # "By Unit" stays unit-level only (no further breakdown needed).
    _build_breakdown_sheet(wb, "By Unit", "Unit-wise Downtime", filters,
                            ["Unit", "Downtime (min)"],
                            [[d["name"], d["minutes"]] for d in stats["unitData"]],
                            data_bar_col=2, col_widths=[26, 18, 14, 14, 14])

    # Every other sheet breaks its numbers down per-unit/department, one row each,
    # so it's clear which unit each figure belongs to.
    _build_breakdown_sheet(wb, "By Machine", "Machine / Department-wise Downtime", filters,
                            ["Unit", "Machine", "Downtime (min)"],
                            compute_grouped_by_unit(rows, _machine_label, mode="minutes"),
                            data_bar_col=3, col_widths=[20, 30, 16, 14, 14])

    _build_breakdown_sheet(wb, "By Category", "Device Detail (Category)-wise Breakdown", filters,
                            ["Unit", "Device Detail", "Count"],
                            compute_grouped_by_unit(rows, lambda r: r.get("deviceDetail") or "Unspecified", mode="count"),
                            data_bar_col=3, data_bar_color="3FB6A8", col_widths=[20, 26, 12, 14, 14])

    _build_breakdown_sheet(wb, "By Fault", "Fault Category-wise Breakdown", filters,
                            ["Unit", "Fault Category", "Count"],
                            compute_grouped_by_unit(rows, lambda r: r.get("faultCategory") or "Unknown", mode="count"),
                            data_bar_col=3, data_bar_color="3FB6A8", col_widths=[20, 30, 12, 14, 14])

    _build_breakdown_sheet(wb, "By Shift", "Shift-wise Distribution", filters,
                            ["Unit", "Shift", "Count"],
                            compute_grouped_by_unit(rows, lambda r: r.get("shift") or "?", mode="count"),
                            data_bar_col=3, data_bar_color="6B8FF0", col_widths=[20, 12, 12, 14, 14])

    _build_breakdown_sheet(wb, "By Technician", "Technician-wise Workload", filters,
                            ["Unit", "Technician", "Jobs"],
                            compute_grouped_by_unit(rows, lambda r: split_technicians(r.get("technician")) or ["Unknown"], mode="count", explode=True),
                            data_bar_col=3, data_bar_color="E0637A", col_widths=[20, 22, 12, 14, 14])

    _build_breakdown_sheet(wb, "By Day", "Day-wise Downtime Trend", filters,
                            ["Unit", "Date", "Downtime (min)"],
                            compute_grouped_by_unit(rows, lambda r: r.get("date") or "?", mode="minutes", sort="name"),
                            data_bar_col=3, col_widths=[20, 14, 16, 14, 14])
    _build_records_sheet(wb, rows)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return Response(
        buf.read(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=breakdown_report.xlsx"},
    )


@app.route("/api/reports/performance-export")
@login_required
def api_reports_performance_export():
    technicians = [t for t in request.args.getlist("technician") if t]
    if not technicians:
        technicians = [r["value"] for r in get_db().execute(
            "SELECT DISTINCT value FROM reference_items WHERE category='technician' ORDER BY value")]
    start = request.args.get("start") or None
    end = request.args.get("end") or None
    units = [u for u in request.args.getlist("unit") if u] or None

    filters = {"start": start, "end": end, "unit": units, "technician": technicians}
    per_tech = [compute_technician_report(t, start, end, units) for t in technicians]

    wb = Workbook()
    _build_perf_summary_sheet(wb, per_tech, filters)
    _build_perf_monthly_sheet(wb, per_tech, filters)
    _build_perf_daily_sheet(wb, per_tech, filters)
    rows = query_records(start=start, end=end, technician=technicians, unit=units)
    _build_records_sheet(wb, rows)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return Response(
        buf.read(),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=technician_performance_report.xlsx"},
    )


# ---- xlsx report styling helpers ----

_HEADER_FILL = PatternFill("solid", fgColor="1F2933")
_ACCENT_FILL = PatternFill("solid", fgColor="F5A524")
_SUBTLE_FILL = PatternFill("solid", fgColor="F4F1EA")
_BORDER = Border(*(Side(style="thin", color="D8D8D8"),) * 4)
_TITLE_FONT = Font(name="Calibri", size=17, bold=True, color="1F2933")
_SUB_FONT = Font(name="Calibri", size=10, color="6B7280")
_SECTION_FONT = Font(name="Calibri", size=12, bold=True, color="1F2933")
_HEADER_FONT = Font(name="Calibri", size=10, bold=True, color="FFFFFF")
_KPI_LABEL_FONT = Font(name="Calibri", size=9, color="6B7280")
_KPI_VALUE_FONT = Font(name="Calibri", size=16, bold=True, color="1F2933")


def _autosize(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _write_kpi_block(ws, row, col, label, value):
    """Renders one KPI as a small bordered 'card' (light fill + accent-orange
    top edge) so the summary sheet reads like a real dashboard, not a plain list."""
    top_border = Side(style="medium", color="F5A524")
    thin = Side(style="thin", color="D8D8D8")
    for i, r in enumerate((row, row + 1)):
        c = ws.cell(row=r, column=col)
        c.fill = _SUBTLE_FILL
        c.border = Border(left=thin, right=thin, top=top_border if i == 0 else thin, bottom=thin)
    ws.cell(row=row, column=col, value=label).font = _KPI_LABEL_FONT
    c = ws.cell(row=row + 1, column=col, value=value)
    c.font = _KPI_VALUE_FONT
    ws.row_dimensions[row].height = 16
    ws.row_dimensions[row + 1].height = 24


def _filters_description(filters):
    range_desc = []
    def fmt(v):
        vals = v if isinstance(v, list) else [v]
        return ", ".join(str(x) for x in vals)

    if filters.get("start"):
        range_desc.append(f"From: {filters['start']}")
    if filters.get("end"):
        range_desc.append(f"To: {filters['end']}")
    if filters.get("unit"):
        range_desc.append(f"Unit: {fmt(filters['unit'])}")
    if filters.get("machine"):
        range_desc.append(f"Machine: {fmt(filters['machine'])}")
    if filters.get("machineNo"):
        range_desc.append(f"Machine No.: {fmt(filters['machineNo'])}")
    if filters.get("shift"):
        range_desc.append(f"Shift: {fmt(filters['shift'])}")
    if filters.get("technician"):
        range_desc.append(f"Technician: {fmt(filters['technician'])}")
    if filters.get("fault"):
        range_desc.append(f"Fault: {fmt(filters['fault'])}")
    if filters.get("complaintReference"):
        range_desc.append(f"Complaint Ref: {fmt(filters['complaintReference'])}")
    if filters.get("notificationType"):
        range_desc.append(f"Notification Type: {fmt(filters['notificationType'])}")
    if filters.get("hour"):
        hours = filters["hour"] if isinstance(filters["hour"], list) else [filters["hour"]]
        range_desc.append(f"Hour: {', '.join(str(h).zfill(2) + ':00' for h in hours)}")
    return " | ".join(range_desc) if range_desc else "All records (no filters applied)"


def _report_subtitle():
    """Subtitle line shown under each report banner. Lists the actual units in
    the system instead of a hardcoded label, so it always matches this mill's
    real setup (e.g. 'Unit-01 - 45mtr, Unit-02 - D12')."""
    try:
        names = [r["name"] for r in get_db().execute("SELECT name FROM units ORDER BY name").fetchall()]
    except Exception:
        names = []
    if not names:
        return "Machine Breakdown Report"
    if len(names) > 3:
        return "Machine Breakdown Report — All Units"
    return "Machine Breakdown Report — " + ", ".join(names)


def _write_report_header(ws, title, filters, span_cols=5, is_summary=False):
    """Letterhead-style header used at the top of every report sheet: a dark
    banner strip with the sheet title and a "back to contents" link (except
    on the Summary page itself), a thin accent strip beneath it for a
    polished, branded feel, then the active filters and generated timestamp
    — so each sheet is self-explanatory without repeating a full page of
    boilerplate."""
    last_col = get_column_letter(span_cols)
    title_end_col = span_cols - 1 if (span_cols > 1 and not is_summary) else span_cols
    title_end_letter = get_column_letter(title_end_col)

    ws.merge_cells(f"A1:{title_end_letter}1")
    banner = ws["A1"]
    banner.value = "  " + title
    banner.font = Font(name="Calibri", size=15, bold=True, color="FFFFFF")
    banner.fill = _HEADER_FILL
    banner.alignment = Alignment(vertical="center", horizontal="left")
    ws.row_dimensions[1].height = 30
    for cc in range(2, span_cols + 1):
        ws.cell(row=1, column=cc).fill = _HEADER_FILL

    if not is_summary:
        back_cell = ws.cell(row=1, column=span_cols, value="← Contents")
        back_cell.font = Font(name="Calibri", size=10, bold=True, color="FFD79A")
        back_cell.alignment = Alignment(vertical="center", horizontal="right")
        back_cell.hyperlink = "#'Summary'!A1"

    for cc in range(1, span_cols + 1):
        ws.cell(row=2, column=cc).fill = _ACCENT_FILL
    ws.row_dimensions[2].height = 4

    ws.merge_cells(f"A3:{last_col}3")
    ws["A3"] = _report_subtitle()
    ws["A3"].font = _SUB_FONT

    ws.merge_cells(f"A4:{last_col}4")
    ws["A4"] = _filters_description(filters)
    ws["A4"].font = _SUB_FONT

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    ws.merge_cells(f"A5:{last_col}5")
    ws["A5"] = f"Generated: {generated}"
    ws["A5"].font = _SUB_FONT
    return 7  # next free row


def _write_table(ws, start_row, headers, data_rows, data_bar_col=None, data_bar_color="F5A524"):
    """Writes a styled table (header row + data rows). If data_bar_col is given
    (1-indexed column within the table), an in-cell data-bar is applied to that
    column's values — a clean, professional way to show relative magnitude
    without embedding a chart."""
    r = start_row
    header_row = r
    for j, h in enumerate(headers, start=1):
        c = ws.cell(row=r, column=j, value=h)
        c.font = _HEADER_FONT
        c.fill = _HEADER_FILL
        c.border = _BORDER
        c.alignment = Alignment(horizontal="left", vertical="center")
    r += 1
    data_start = r
    for data in data_rows:
        for j, val in enumerate(data, start=1):
            c = ws.cell(row=r, column=j, value=val)
            c.border = _BORDER
            if r % 2 == 0:
                c.fill = _SUBTLE_FILL
        r += 1
    data_end = max(r - 1, data_start)

    if data_bar_col and data_rows:
        col_letter = get_column_letter(data_bar_col)
        rng = f"{col_letter}{data_start}:{col_letter}{data_end}"
        rule = DataBarRule(start_type="num", start_value=0, end_type="max",
                            color=data_bar_color, showValue=True, minLength=None, maxLength=None)
        ws.conditional_formatting.add(rng, rule)

    return {"next_row": r + 1, "header_row": header_row, "data_start": data_start,
            "data_end": data_end, "has_data": len(data_rows) > 0}


def _write_mini_banner(ws, row, text, span_cols=5):
    """Small accent-colored section banner (KEY METRICS / OVERVIEW / CONTENTS)
    used to visually separate the summary sheet into clear sections, the way
    a real BI/Crystal Reports document would."""
    last_col = get_column_letter(span_cols)
    ws.merge_cells(f"A{row}:{last_col}{row}")
    c = ws.cell(row=row, column=1, value="  " + text)
    c.font = Font(name="Calibri", size=10.5, bold=True, color="FFFFFF")
    c.fill = _ACCENT_FILL
    c.alignment = Alignment(vertical="center", horizontal="left")
    ws.row_dimensions[row].height = 20
    return row + 1


def _build_summary_sheet(wb, stats, filters):
    """Short overview sheet: banner header, boxed KPI cards, a one-paragraph
    executive summary, and a clickable contents table linking to every other
    sheet. All detailed breakdowns live on their own dedicated sheets (see
    _build_breakdown_sheet), so this page stays a single screen — no more
    scrolling through a very long combined report."""
    ws = wb.active
    ws.title = "Summary"
    _autosize(ws, [30, 20, 20, 20, 20])

    row = _write_report_header(ws, "Executive Summary", filters, is_summary=True)

    row = _write_mini_banner(ws, row, "KEY METRICS")
    row += 1
    kpis = [
        ("Total Breakdowns", stats["total"]),
        ("Total Downtime (min)", stats["totalMinutes"]),
        ("Avg Downtime (min)", stats["avgMinutes"]),
        ("Most Affected Machine", stats["topMachine"]),
        ("Machines Affected", stats["distinctMachines"]),
    ]
    for i, (label, value) in enumerate(kpis):
        _write_kpi_block(ws, row, 1 + i, label, value)
    row += 3

    row = _write_mini_banner(ws, row, "OVERVIEW")
    row += 1
    total_hours = stats["totalMinutes"] // 60
    total_mins_rem = stats["totalMinutes"] % 60
    unit_phrase = (f"across {stats['distinctUnits']} unit(s)" if stats["distinctUnits"] > 1
                   else (f"in {stats['unitData'][0]['name']}" if stats["unitData"] else ""))
    summary_text = (
        f"During the reporting period {unit_phrase}, {stats['total']} breakdown(s) were recorded, "
        f"totalling {total_hours}h {total_mins_rem}m of downtime (average {stats['avgMinutes']} minutes per event). "
        f"{stats['distinctMachines']} machine(s) were affected across {stats['distinctFaults']} distinct fault "
        f"type(s), attended by {stats['distinctTechnicians']} technician(s). "
        f"The most affected machine was \"{stats['topMachine']}\"."
    )
    ws.merge_cells(f"A{row}:E{row+2}")
    sc = ws.cell(row=row, column=1, value=summary_text)
    sc.font = Font(name="Calibri", size=10.5, color="374151")
    sc.alignment = Alignment(wrap_text=True, vertical="top", horizontal="left")
    sc.fill = _SUBTLE_FILL
    for rr in range(row, row + 3):
        for cc in range(1, 6):
            ws.cell(row=rr, column=cc).border = _BORDER
            ws.cell(row=rr, column=cc).fill = _SUBTLE_FILL
    row += 4

    # ---- clickable contents table (jumps straight to any sheet) ----
    row = _write_mini_banner(ws, row, "CONTENTS — click a sheet name to jump to it")
    contents = [
        ("Summary", "This page — KPIs and executive overview"),
        ("By Unit", "Downtime totals per unit / department"),
        ("By Machine", "Downtime per machine, broken down by unit"),
        ("By Category", "Device detail breakdown, per unit"),
        ("By Fault", "Fault-type breakdown, per unit"),
        ("By Shift", "Shift-wise breakdown, per unit"),
        ("By Technician", "Technician workload, per unit"),
        ("By Day", "Day-wise downtime trend, per unit"),
        ("Records", "Full raw record detail (every field)"),
    ]
    for j, h in enumerate(["Sheet", "Description"], start=1):
        c = ws.cell(row=row, column=j, value=h)
        c.font = _HEADER_FONT
        c.fill = _HEADER_FILL
        c.border = _BORDER
    row += 1
    for sheet_name, desc in contents:
        link_cell = ws.cell(row=row, column=1, value=f"→ {sheet_name}")
        link_cell.font = Font(name="Calibri", size=10.5, bold=True, color="B4690E")
        link_cell.border = _BORDER
        link_cell.hyperlink = f"#'{sheet_name}'!A1"
        desc_cell = ws.cell(row=row, column=2, value=desc)
        desc_cell.font = Font(name="Calibri", size=10, color="374151")
        desc_cell.border = _BORDER
        if row % 2 == 0:
            link_cell.fill = _SUBTLE_FILL
            desc_cell.fill = _SUBTLE_FILL
        row += 1

    ws.freeze_panes = "A7"


def _build_breakdown_sheet(wb, sheet_name, title, filters, headers, data_rows,
                            data_bar_col=2, data_bar_color="F5A524", col_widths=None):
    """One focused, short report page per breakdown dimension (unit, machine,
    category, fault, shift, technician, day) — mirrors how Crystal Reports /
    SSRS split a long report into separate report pages instead of one long scroll.
    Rows are typically (Unit, <dimension>, value) so every department's figures
    are shown as their own row rather than merged across units."""
    ws = wb.create_sheet(sheet_name)
    _autosize(ws, col_widths or [34, 18, 14, 14, 14])
    row = _write_report_header(ws, title, filters, span_cols=max(5, len(headers)))
    t = _write_table(ws, row, headers, data_rows, data_bar_col=data_bar_col, data_bar_color=data_bar_color)

    if not t["has_data"]:
        ws.cell(row=row + 1, column=1, value="No data found for this filter.").font = _SUB_FONT
    else:
        total_row = t["data_end"] + 2
        ws.cell(row=total_row, column=1, value=f"Total entries: {len(data_rows)}").font = Font(
            name="Calibri", size=9.5, italic=True, color="6B7280")

    ws.freeze_panes = f"A{row + 1}"


def _build_records_sheet(wb, rows):
    ws = wb.create_sheet("Records")
    # Records are listed oldest-first (chronological), by date then start time,
    # so the sheet reads as a running log from the start of the period.
    rows = sorted(rows, key=lambda r: (r.get("date") or "", r.get("timeStart") or ""))
    headers = ["Date", "Unit", "Complaint Reference", "Notification Type", "Ticket No.", "Order No.", "Machine", "Machine No.",
               "Device Detail", "Device Sub-Category", "Fault Category", "Reason / RCA",
               "Action Taken", "Shift", "Technician", "Time Start", "Time Finish",
               "Downtime", "Downtime (min)", "Remarks"]
    keys = ["date", "unit", "complaintReference", "notificationType", "ticketNo", "orderNo", "machine", "machineNo",
            "deviceDetail", "deviceSubCat", "faultCategory", "reason",
            "actionTaken", "shift", "technician", "timeStart", "timeFinish",
            "downtime", None, "remarks"]
    minutes_col = keys.index(None) + 1  # 1-indexed column for the numeric minutes value

    for j, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=j, value=h)
        c.font = _HEADER_FONT
        c.fill = _HEADER_FILL
        c.border = _BORDER

    back_cell = ws.cell(row=1, column=len(headers) + 2, value="← Back to Summary")
    back_cell.font = Font(name="Calibri", size=10, bold=True, color="B4690E")
    back_cell.hyperlink = "#'Summary'!A1"

    for i, r in enumerate(rows, start=2):
        for j, k in enumerate(keys, start=1):
            if k is None:
                # numeric minutes, kept as a real number so it can be summed/filtered in Excel
                c = ws.cell(row=i, column=j, value=downtime_to_minutes(r.get("downtime", "")))
                c.number_format = "0"
            else:
                c = ws.cell(row=i, column=j, value=r.get(k, ""))
            c.border = _BORDER
            if i % 2 == 0:
                c.fill = _SUBTLE_FILL

    ws.freeze_panes = "A2"
    widths = [12, 18, 16, 16, 10, 12, 14, 10, 16, 16, 20, 22, 30, 8, 16, 10, 10, 10, 14, 20]
    _autosize(ws, widths)


# ---- performance report (per technician) ----

def _perf_contents_rows():
    return [
        ("Summary", "This page — KPIs and per-technician summary"),
        ("Monthly", "Month-by-month efficiency, per technician"),
        ("Daily Detail", "Every active day, per technician (with hours used)"),
        ("Records", "Full raw breakdown records for these technicians"),
    ]


def _build_perf_summary_sheet(wb, per_tech, filters):
    ws = wb.active
    ws.title = "Summary"
    _autosize(ws, [26, 16, 20, 16, 16])
    row = _write_report_header(ws, "Technician Performance — Summary", filters, is_summary=True)

    row = _write_mini_banner(ws, row, "KEY METRICS")
    row += 1
    total_min = sum(p["summary"]["minutes"] for p in per_tech)
    total_days = sum(p["summary"]["daysWorked"] for p in per_tech)
    total_avail_h = sum(p["summary"]["hoursAvailable"] for p in per_tech)
    overall_eff = round((total_min / (total_avail_h * 60)) * 100, 1) if total_avail_h else 0.0
    active = [p for p in per_tech if p["summary"]["minutes"] > 0]
    best = max(active, key=lambda p: p["summary"]["efficiency"]) if active else None
    kpis = [
        ("Technicians", len(per_tech)),
        ("Total Time Worked (min)", total_min),
        ("Total Days Worked", total_days),
        ("Overall Efficiency %", overall_eff),
        ("Top Technician", best["technician"] if best else "\u2014"),
    ]
    for i, (label, value) in enumerate(kpis):
        _write_kpi_block(ws, row, 1 + i, label, value)
    row += 3

    row = _write_mini_banner(ws, row, "PER-TECHNICIAN SUMMARY")
    headers = ["Technician", "Days Worked", "Time Worked (min)", "Available (h)", "Efficiency %"]
    data = [[p["technician"], p["summary"]["daysWorked"], p["summary"]["minutes"],
             p["summary"]["hoursAvailable"], p["summary"]["efficiency"]]
            for p in sorted(per_tech, key=lambda p: -p["summary"]["efficiency"])]
    t = _write_table(ws, row, headers, data, data_bar_col=5, data_bar_color="1F9D6B")
    row = t["next_row"] + 1

    row = _write_mini_banner(ws, row, "CONTENTS — click a sheet name to jump to it")
    for j, h in enumerate(["Sheet", "Description"], start=1):
        cc = ws.cell(row=row, column=j, value=h)
        cc.font = _HEADER_FONT
        cc.fill = _HEADER_FILL
        cc.border = _BORDER
    row += 1
    for sheet_name, desc in _perf_contents_rows():
        link = ws.cell(row=row, column=1, value=f"\u2192 {sheet_name}")
        link.font = Font(name="Calibri", size=10.5, bold=True, color="B4690E")
        link.border = _BORDER
        link.hyperlink = f"#'{sheet_name}'!A1"
        d = ws.cell(row=row, column=2, value=desc)
        d.font = Font(name="Calibri", size=10, color="374151")
        d.border = _BORDER
        if row % 2 == 0:
            link.fill = _SUBTLE_FILL
            d.fill = _SUBTLE_FILL
        row += 1
    ws.freeze_panes = "A7"


def _build_perf_monthly_sheet(wb, per_tech, filters):
    headers = ["Technician", "Month", "Days Worked", "Time Worked (min)", "Efficiency %"]
    data = []
    for p in per_tech:
        for m in p["months"]:
            data.append([p["technician"], m["month"], m["daysWorked"], m["minutes"], m["efficiency"]])
    _build_breakdown_sheet(wb, "Monthly", "Monthly Efficiency (per Technician)", filters,
                            headers, data, data_bar_col=5, data_bar_color="1F9D6B",
                            col_widths=[22, 14, 14, 18, 14])


def _build_perf_daily_sheet(wb, per_tech, filters):
    headers = ["Technician", "Date", "Breakdowns", "Time Worked (min)", "Hours / Day", "Efficiency %"]
    data = []
    for p in per_tech:
        for d in p["days"]:
            data.append([p["technician"], d["date"], d["breakdowns"], d["minutes"], d["hours"], d["efficiency"]])
    _build_breakdown_sheet(wb, "Daily Detail", "Day-by-day Efficiency (per Technician)", filters,
                            headers, data, data_bar_col=6, data_bar_color="1F9D6B",
                            col_widths=[22, 14, 12, 18, 12, 14])


# ---------------------------------------------------------------- API: users & account

@app.route("/api/me")
@login_required
def api_me():
    return jsonify(current_user())


@app.route("/api/change-password", methods=["POST"])
@login_required
def api_change_password():
    data = request.get_json(force=True) or {}
    current_pw = data.get("currentPassword", "")
    new_pw = data.get("newPassword", "")
    if not current_pw or not new_pw:
        return jsonify({"error": "Please fill in both fields."}), 400
    if len(new_pw) < 4:
        return jsonify({"error": "New password must be at least 4 characters."}), 400

    user = current_user()
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    if not check_password_hash(row["password_hash"], current_pw):
        return jsonify({"error": "Current password is incorrect."}), 400

    db.execute("UPDATE users SET password_hash=? WHERE id=?", (generate_password_hash(new_pw), user["id"]))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/users", methods=["GET"])
@admin_required
def api_list_users():
    rows = get_db().execute(
        "SELECT id, username, role, can_add_data, can_edit_delete, createdAt FROM users ORDER BY createdAt"
    ).fetchall()
    result = []
    for r in rows:
        d = row_to_dict(r)
        d["can_add_data"] = bool(d["can_add_data"])
        d["can_edit_delete"] = bool(d["can_edit_delete"])
        result.append(d)
    return jsonify(result)


@app.route("/api/users", methods=["POST"])
@admin_required
def api_create_user():
    data = request.get_json(force=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    role = data.get("role", "operator")
    can_add_data = 1 if data.get("can_add_data") else 0
    can_edit_delete = 1 if data.get("can_edit_delete") else 0
    if role not in ("admin", "operator"):
        role = "operator"
    if not username or not password:
        return jsonify({"error": "Username and password are required."}), 400
    if len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters."}), 400

    db = get_db()
    try:
        uid = "u-" + uuid.uuid4().hex[:10]
        db.execute(
            "INSERT INTO users (id, username, password_hash, role, can_add_data, can_edit_delete, createdAt) VALUES (?,?,?,?,?,?,?)",
            (uid, username, generate_password_hash(password), role, can_add_data, can_edit_delete, now_iso()),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "This username already exists."}), 400
    return jsonify({"id": uid, "username": username, "role": role,
                     "can_add_data": bool(can_add_data), "can_edit_delete": bool(can_edit_delete)}), 201


@app.route("/api/users/<user_id>", methods=["PATCH"])
@admin_required
def api_update_user(user_id):
    data = request.get_json(force=True) or {}
    db = get_db()
    target = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not target:
        return jsonify({"error": "User not found."}), 404

    if "username" in data:
        new_username = (data["username"] or "").strip()
        if not new_username:
            return jsonify({"error": "Username cannot be empty."}), 400
        existing = db.execute(
            "SELECT id FROM users WHERE username=? AND id!=?", (new_username, user_id)
        ).fetchone()
        if existing:
            return jsonify({"error": "This username already exists."}), 400
        db.execute("UPDATE users SET username=? WHERE id=?", (new_username, user_id))

    if "password" in data and data["password"]:
        if len(data["password"]) < 4:
            return jsonify({"error": "Password must be at least 4 characters."}), 400
        db.execute("UPDATE users SET password_hash=? WHERE id=?",
                   (generate_password_hash(data["password"]), user_id))

    if "role" in data:
        new_role = data["role"] if data["role"] in ("admin", "operator") else target["role"]
        if target["role"] == "admin" and new_role != "admin":
            admin_count = db.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]
            if admin_count <= 1:
                return jsonify({"error": "The last admin's role cannot be changed."}), 400
        db.execute("UPDATE users SET role=? WHERE id=?", (new_role, user_id))

    if "can_add_data" in data:
        db.execute("UPDATE users SET can_add_data=? WHERE id=?", (1 if data["can_add_data"] else 0, user_id))
    if "can_edit_delete" in data:
        db.execute("UPDATE users SET can_edit_delete=? WHERE id=?", (1 if data["can_edit_delete"] else 0, user_id))

    db.commit()
    row = db.execute(
        "SELECT id, username, role, can_add_data, can_edit_delete, createdAt FROM users WHERE id=?", (user_id,)
    ).fetchone()
    d = row_to_dict(row)
    d["can_add_data"] = bool(d["can_add_data"])
    d["can_edit_delete"] = bool(d["can_edit_delete"])
    return jsonify(d)


@app.route("/api/users/<user_id>", methods=["DELETE"])
@admin_required
def api_delete_user(user_id):
    db = get_db()
    if user_id == session.get("user_id"):
        return jsonify({"error": "You cannot delete yourself."}), 400
    admin_count = db.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]
    target = db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if target and target["role"] == "admin" and admin_count <= 1:
        return jsonify({"error": "The last admin cannot be deleted."}), 400
    db.execute("DELETE FROM users WHERE id=?", (user_id,))
    db.commit()
    return jsonify({"deleted": user_id})


# ---------------------------------------------------------------- error pages

@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found."}), 404
    return render_template("error.html", code=404, title="Page Not Found",
                            message="This page does not exist, or the URL is incorrect."), 404


@app.errorhandler(403)
def forbidden(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Forbidden."}), 403
    return render_template("error.html", code=403, title="Access Denied",
                            message="You do not have permission to access this page."), 403


@app.errorhandler(500)
def server_error(e):
    app.logger.error(f"Unhandled error on {request.path}: {e}", exc_info=True)
    if request.path.startswith("/api/"):
        return jsonify({"error": "Server error."}), 500
    return render_template("error.html", code=500, title="Something Went Wrong",
                            message="A server error occurred. Please try again shortly."), 500


# ---------------------------------------------------------------- main

if __name__ == "__main__":
    created_admin = init_db()
    if created_admin:
        print("[setup] Default admin user bana diya gaya -> username: admin | password: admin123")
        print("[setup] Please change the password from the Account page after logging in.")
    print(f"[server] Machine Breakdown Tracker is running -> http://{HOST}:{PORT}")
    print(f"[server] Accessible from any device on this network at: http://<this-PC-IP>:{PORT}")
    print(f"[server] Logs are being saved to: {LOG_PATH}")
    print(f"[server] Session name (login cookie): {SESSION_NAME}  (har copy ka alag hona chahiye)")

    try:
        from waitress import serve
        have_waitress = True
    except ImportError:
        have_waitress = False
        print("[server] 'waitress' not found, running on Flask's built-in dev server instead.")
        print("[server] For better performance: pip install waitress")

    # The app must keep running until someone deliberately closes it — a
    # dropped network cable, a Wi-Fi hiccup, or a client's connection being
    # reset mid-request can raise a low-level socket error (e.g. Windows
    # "forcibly closed"/"connection aborted" errors) that would otherwise
    # bubble up and kill the whole process. This loop catches anything of
    # that kind, logs it, and brings the server straight back up in-process
    # — instead of relying on the .bat file noticing the process died and
    # restarting it several seconds later.
    restart_count = 0
    while True:
        try:
            if have_waitress:
                # Production-grade WSGI server (no "development server" warning,
                # better suited for multiple LAN users hitting the app at once).
                serve(app, host=HOST, port=PORT, threads=8)
            else:
                app.run(host=HOST, port=PORT, debug=False)
            # serve()/app.run() only return on a clean shutdown (e.g. Ctrl+C) —
            # treat that as an intentional stop, not something to restart.
            break
        except KeyboardInterrupt:
            break
        except Exception as e:
            restart_count += 1
            app.logger.error(f"Server loop error (restart #{restart_count}): {e}", exc_info=True)
            print(f"[server] Recovered from an error and is restarting automatically ({e}).")
            time.sleep(2)
