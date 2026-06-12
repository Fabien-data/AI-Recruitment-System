"""
One-time prod migration: normalise candidate phone numbers to E.164 and merge the
``+94...`` / ``94...`` duplicate pairs in BOTH databases.

Context: the agent "Add candidate" flow stored ``+94775774171`` while Meta's
inbound webhook stored the raw wa_id ``94775774171``. With no shared normaliser
those forked into two candidate rows (two chats). The code fix stops NEW splits;
this collapses the EXISTING ones so the agent-added chat is the single canonical
chat that holds the messages + CV.

Runs through the local cloud-sql-proxy (127.0.0.1:5433) — same path as the
read-only verification. Creds come from env (VDB_USER / VDB_PASS / VDB_PORT),
never hard-coded.

  chatbot_db (int PK):     survivor = the '+' (agent) row. Re-point conversations,
                           applications, pending_sync -> survivor; carry over CV /
                           profile fields the survivor lacks; HARD-delete losers
                           (phone_number is UNIQUE so the row must go); normalise
                           survivor + singletons to E.164.

  recruitment_db (uuid PK):survivor = the agent-added row (source='manual', else the
                           '+' row, else the one with more messages, else oldest).
                           Re-point applications (dedup job_id), communications,
                           cv_files, notification_queue -> survivor; carry over
                           name/email/whatsapp_phone/cv_uploaded the survivor lacks;
                           SOFT-delete losers (status='merged', merged_into_id,
                           removed_at) and mangle their phone so the canonical value
                           is freed for the survivor; normalise survivor + singletons.

Safety: DRY-RUN by default (prints the plan, writes nothing). --apply commits in ONE
transaction per DB (rolls back on any error). --phone limits to one logical number.

Usage:
    # show plan, no writes:
    python merge_phone_duplicates.py
    python merge_phone_duplicates.py --phone 94775774171
    # apply:
    python merge_phone_duplicates.py --apply
    python merge_phone_duplicates.py --phone 94775774171 --apply
    # one DB only:
    python merge_phone_duplicates.py --db recruitment --apply
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict

import psycopg2
import psycopg2.extras

sys.stdout.reconfigure(encoding="utf-8")

HOST = "127.0.0.1"
PORT = int(os.environ.get("VDB_PORT", "5433"))
USER = os.environ["VDB_USER"]
PASS = os.environ["VDB_PASS"]


# ── Normaliser: identical rules to app/utils/phone.py and backend utils/phone.js ──
def normalize_phone(raw):
    if raw is None:
        return None
    raw_str = str(raw).strip()
    digits = re.sub(r"\D", "", raw_str)
    if not digits:
        return None
    if digits.startswith("0") and len(digits) == 10:
        return "+94" + digits[1:]
    if digits.startswith("94") and len(digits) == 11:
        return "+" + digits
    if raw_str.startswith("+") and 10 <= len(digits) <= 15:
        return "+" + digits
    if not digits.startswith("0") and 10 <= len(digits) <= 15:
        return "+" + digits
    return None


def norm_or_raw(raw):
    if raw is None:
        return None
    return normalize_phone(raw) or str(raw).strip()


def _selftest():
    cases = {
        "94775774171": "+94775774171", "+94775774171": "+94775774171",
        "0775774171": "+94775774171", "971501234567": "+971501234567",
    }
    for k, v in cases.items():
        assert normalize_phone(k) == v, f"normaliser parity FAILED: {k!r} -> {normalize_phone(k)!r} != {v!r}"


def conn(dbname):
    return psycopg2.connect(host=HOST, port=PORT, dbname=dbname, user=USER,
                            password=PASS, connect_timeout=20)


def _present(v):
    if v is None:
        return False
    if isinstance(v, str):
        return v.strip() != ""
    return True


# ══════════════════════════════ chatbot_db ══════════════════════════════
def migrate_chatbot(apply, phone_filter, normalize_singletons):
    print("\n" + "=" * 72)
    print("chatbot_db  " + ("(APPLY)" if apply else "(DRY-RUN)"))
    print("=" * 72)
    c = conn("chatbot_db")
    c.autocommit = False
    cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        target = norm_or_raw(phone_filter) if phone_filter else None
        cur.execute("""SELECT id, phone_number, name, email, age, highest_qualification,
                              skills, experience_years, notice_period, resume_file_path,
                              extracted_data, conversation_state, cv_sync_status,
                              last_inbound_at, created_at
                       FROM candidates""")
        rows = cur.fetchall()
        groups = defaultdict(list)
        for r in rows:
            canon = norm_or_raw(r["phone_number"])
            if target and canon != target:
                continue
            groups[canon].append(r)

        dups = {k: v for k, v in groups.items() if len(v) > 1}
        singles = [v[0] for k, v in groups.items()
                   if len(v) == 1 and v[0]["phone_number"] != k] if normalize_singletons else []
        print(f"duplicate groups: {len(dups)} | singletons to normalise: {len(singles)}"
              f"{'' if normalize_singletons else '  (singleton normalisation OFF — pass --normalize-singletons to enable)'}")

        repointed = deleted = 0
        for canon, grp in sorted(dups.items(), key=lambda kv: kv[0] or ""):
            grp_sorted = sorted(grp, key=lambda r: (
                not str(r["phone_number"] or "").startswith("+"),
                not bool((r["name"] or "").strip()),
                r["id"],
            ))
            keep, losers = grp_sorted[0], grp_sorted[1:]
            print(f"\nGROUP {canon}  keep id={keep['id']} ({keep['phone_number']!r}, {keep['name']!r})")
            for lo in losers:
                cur.execute("SELECT count(*) AS n FROM conversations WHERE candidate_id=%s", (lo["id"],))
                nconv = cur.fetchone()["n"]
                print(f"   merge id={lo['id']} ({lo['phone_number']!r}, {lo['name']!r}) "
                      f"-> move {nconv} msgs; delete")
                if apply:
                    for tbl in ("conversations", "applications", "pending_sync"):
                        cur.execute(f"UPDATE {tbl} SET candidate_id=%s WHERE candidate_id=%s",
                                    (keep["id"], lo["id"]))
                        repointed += cur.rowcount
                    _carry_chatbot(cur, keep, lo)
            if apply:
                for lo in losers:
                    cur.execute("DELETE FROM candidates WHERE id=%s", (lo["id"],))
                    deleted += 1
                cur.execute("UPDATE candidates SET phone_number=%s WHERE id=%s",
                            (canon, keep["id"]))

        for r in singles:
            tgt = norm_or_raw(r["phone_number"])
            print(f"NORMALISE id={r['id']}  {r['phone_number']!r} -> {tgt!r}")
            if apply:
                cur.execute("UPDATE candidates SET phone_number=%s WHERE id=%s", (tgt, r["id"]))

        if apply:
            c.commit()
            print(f"\nAPPLIED chatbot_db: {len(dups)} groups merged "
                  f"(deleted {deleted}, re-pointed {repointed}), {len(singles)} normalised.")
        else:
            c.rollback()
            print("\nDRY-RUN chatbot_db: nothing written.")
    except Exception:
        c.rollback()
        raise
    finally:
        cur.close(); c.close()


def _carry_chatbot(cur, keep, lo):
    sets, args = [], []
    for attr in ("name", "email", "age", "highest_qualification", "skills",
                 "experience_years", "notice_period", "resume_file_path", "cv_sync_status"):
        if not _present(keep[attr]) and _present(lo[attr]):
            sets.append(f"{attr}=%s"); args.append(lo[attr]); keep[attr] = lo[attr]
    s_ex = keep["extracted_data"] if isinstance(keep["extracted_data"], dict) else {}
    l_ex = lo["extracted_data"] if isinstance(lo["extracted_data"], dict) else {}
    if l_ex:
        merged = {**l_ex, **s_ex}
        sets.append("extracted_data=%s"); args.append(json.dumps(merged)); keep["extracted_data"] = merged
    if lo["last_inbound_at"] and (not keep["last_inbound_at"] or lo["last_inbound_at"] > keep["last_inbound_at"]):
        sets.append("last_inbound_at=%s"); args.append(lo["last_inbound_at"]); keep["last_inbound_at"] = lo["last_inbound_at"]
    if (keep["conversation_state"] in (None, "", "initial")) and lo["conversation_state"]:
        sets.append("conversation_state=%s"); args.append(lo["conversation_state"]); keep["conversation_state"] = lo["conversation_state"]
    if sets:
        args.append(keep["id"])
        cur.execute(f"UPDATE candidates SET {', '.join(sets)} WHERE id=%s", args)


# ══════════════════════════════ recruitment_db ══════════════════════════════
def migrate_recruitment(apply, phone_filter, normalize_singletons):
    print("\n" + "=" * 72)
    print("recruitment_db  " + ("(APPLY)" if apply else "(DRY-RUN)"))
    print("=" * 72)
    c = conn("recruitment_db")
    c.autocommit = False
    cur = c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        target = norm_or_raw(phone_filter) if phone_filter else None
        cur.execute("""SELECT id, phone, whatsapp_phone, name, email, source, status,
                              cv_uploaded, created_at,
                              (SELECT count(*) FROM communications co WHERE co.candidate_id = candidates.id) AS ncomm
                       FROM candidates
                       WHERE removed_at IS NULL""")
        rows = cur.fetchall()
        groups = defaultdict(list)
        for r in rows:
            canon = norm_or_raw(r["phone"] or r["whatsapp_phone"])
            if not canon:
                continue
            if target and canon != target:
                continue
            groups[canon].append(r)

        dups = {k: v for k, v in groups.items() if len(v) > 1}
        singles = [v[0] for k, v in groups.items()
                   if len(v) == 1 and v[0]["phone"] != k] if normalize_singletons else []
        print(f"duplicate groups: {len(dups)} | singletons to normalise: {len(singles)}"
              f"{'' if normalize_singletons else '  (singleton normalisation OFF — pass --normalize-singletons to enable)'}")

        repointed = merged = 0
        for canon, grp in sorted(dups.items(), key=lambda kv: kv[0] or ""):
            grp_sorted = sorted(grp, key=lambda r: (
                (r["source"] or "") != "manual",                 # agent-added first
                not str(r["phone"] or "").startswith("+"),        # then '+' row
                -(r["ncomm"] or 0),                               # then more messages
                r["created_at"] or r["id"],                       # then oldest
            ))
            keep, losers = grp_sorted[0], grp_sorted[1:]
            print(f"\nGROUP {canon}  keep id={keep['id']} "
                  f"(phone={keep['phone']!r}, src={keep['source']!r}, {keep['ncomm']} msgs, {keep['name']!r})")
            for lo in losers:
                print(f"   merge id={lo['id']} (phone={lo['phone']!r}, src={lo['source']!r}, "
                      f"{lo['ncomm']} msgs, {lo['name']!r}) -> move msgs/CV/apps; soft-delete")
                if apply:
                    # applications: move non-conflicting, drop the rest
                    cur.execute("""UPDATE applications SET candidate_id=%s
                                   WHERE candidate_id=%s
                                     AND NOT EXISTS (SELECT 1 FROM applications ex
                                                     WHERE ex.candidate_id=%s AND ex.job_id=applications.job_id)""",
                                (keep["id"], lo["id"], keep["id"]))
                    repointed += cur.rowcount
                    cur.execute("DELETE FROM applications WHERE candidate_id=%s", (lo["id"],))
                    for tbl in ("communications", "cv_files", "notification_queue"):
                        try:
                            cur.execute(f"UPDATE {tbl} SET candidate_id=%s WHERE candidate_id=%s",
                                        (keep["id"], lo["id"]))
                            repointed += cur.rowcount
                        except psycopg2.Error:
                            c.rollback(); raise
                    _carry_recruitment(cur, keep, lo)
                    # free the canonical phone value off the loser, then soft-delete it
                    cur.execute("""UPDATE candidates
                                   SET phone = %s, whatsapp_phone = NULL,
                                       status='merged', merged_into_id=%s,
                                       removed_at=NOW(), removed_reason='Duplicate phone (normalisation merge)',
                                       updated_at=NOW()
                                   WHERE id=%s""",
                                (f"merged:{lo['id']}", keep["id"], lo["id"]))
                    merged += 1
            if apply:
                cur.execute("""UPDATE candidates
                               SET phone=%s,
                                   whatsapp_phone=COALESCE(NULLIF(whatsapp_phone,''), %s),
                                   updated_at=NOW()
                               WHERE id=%s""",
                            (canon, canon, keep["id"]))

        for r in singles:
            tgt = norm_or_raw(r["phone"])
            print(f"NORMALISE id={r['id']}  {r['phone']!r} -> {tgt!r}")
            if apply:
                try:
                    cur.execute("UPDATE candidates SET phone=%s, updated_at=NOW() WHERE id=%s",
                                (tgt, r["id"]))
                except psycopg2.Error:
                    c.rollback(); raise

        if apply:
            c.commit()
            print(f"\nAPPLIED recruitment_db: {len(dups)} groups merged "
                  f"(soft-deleted {merged}, re-pointed {repointed}), {len(singles)} normalised.")
        else:
            c.rollback()
            print("\nDRY-RUN recruitment_db: nothing written.")
    except Exception:
        c.rollback()
        raise
    finally:
        cur.close(); c.close()


def _carry_recruitment(cur, keep, lo):
    sets, args = [], []
    for attr in ("name", "email"):
        if not _present(keep[attr]) and _present(lo[attr]):
            sets.append(f"{attr}=%s"); args.append(lo[attr]); keep[attr] = lo[attr]
    if not _present(keep["whatsapp_phone"]) and _present(lo["whatsapp_phone"]):
        sets.append("whatsapp_phone=%s"); args.append(norm_or_raw(lo["whatsapp_phone"]))
    if (not keep["cv_uploaded"]) and lo["cv_uploaded"]:
        sets.append("cv_uploaded=TRUE"); keep["cv_uploaded"] = True
    if sets:
        args.append(keep["id"])
        cur.execute(f"UPDATE candidates SET {', '.join(sets)} WHERE id=%s", args)


if __name__ == "__main__":
    _selftest()
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Commit (default: dry-run).")
    ap.add_argument("--phone", default=None, help="Limit to one logical number.")
    ap.add_argument("--db", choices=["chatbot", "recruitment", "both"], default="both")
    ap.add_argument("--normalize-singletons", action="store_true",
                    help="Also rewrite lone non-canonical numbers to E.164 (~7k rows). "
                         "Off by default — the backend/chatbot dual-match lookup makes it optional.")
    args = ap.parse_args()
    if args.db in ("chatbot", "both"):
        migrate_chatbot(args.apply, args.phone, args.normalize_singletons)
    if args.db in ("recruitment", "both"):
        migrate_recruitment(args.apply, args.phone, args.normalize_singletons)
    print("\nDONE.")
