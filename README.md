# Exception-Log Repair ETL (TypeScript + PostgreSQL)

A TypeScript / Node.js ETL job that **repairs rejected records and reloads them**. Rows that failed validation on the way into the `ServReq` (service request) table were parked in an `ExceptionLog` table as raw pipe-delimited strings. This script parses them, fixes what it can using lookup tables, loads the repaired rows into `ServReq`, and stamps each exception as fixed.

> **Note:** This was written against a PostgreSQL database hosted for a university data-engineering course, which is no longer accessible. Connection details come from environment variables.

## 🏗️ Architecture

```
 PostgreSQL (loftsvc)
 ┌──────────────┐   ① extract unfixed (fixstamp IS NULL)
 │ ExceptionLog │──────────────┐
 └──────┬───────┘              ▼
        │            ② parse "name | type | building | date | unit | description"
        │                      ▼
        │            ③ validate + repair against lookups
        │              ┌───────────────────────────┐
        │              │ Tenant · ReqType · Building│
        │              └───────────────────────────┘
        │                      ▼
        │            ④ dry run: fixable vs. can't-fix (with reason)
        │                      ▼
        │   ⑤ one transaction per record:
        └─◄── UPDATE fixstamp ──┤── INSERT ──► ┌─────────┐
                                               │ ServReq │
                                               └─────────┘
                               ▼
            ⑥ verify: loaded ServReq rows + stamped exceptions
```

## ⚙️ How it works
1. **Extract.** Read unfixed exceptions (`fixstamp IS NULL`) and load the lookup tables (`Tenant`, `ReqType`, `Building`).
2. **Parse.** Split each record on `|` into name, type, building, date, unit, and description.
3. **Validate and repair**, one field at a time:
   | Field | Rule / repair |
   |---|---|
   | Name | Must have first + last name and match a tenant |
   | Type | Case-insensitive lookup. Fallbacks: "Internet" in the description → `connectivity`, `outlets` → `electrical` |
   | Unit | Must be an integer from 101 to 898 |
   | Building | Name lookup. If it's missing, the building is **inferred from the unit number** using each building's `unitrange` |
   | Date | Strict `YYYY-MM-DD` in the current year (rejects dates like `2024-02-31`). If it's missing or bad, the **last valid date** is carried forward |
   | Description | Required |
4. **Dry run.** Print what would be fixed and why each remaining record can't be fixed.
5. **Load.** For each fixed record, `INSERT` into `ServReq` (tagged with its `exceptid`) and set `ExceptionLog.fixstamp` **in one transaction**, so a record is never loaded without being marked fixed, or the other way around.
6. **Verify.** Show the `ServReq` rows that came from the exception log and the exceptions that are now stamped.

## 🧩 Design notes
- **Typed results.** `fixRecord` returns a discriminated union (`{ ok: true, fixed } | { ok: false, reason }`), so the compiler makes every failure path get handled.
- **Pure repair logic.** Validation is separate from database I/O, so it can be unit-tested without a database.
- **Parameterized queries** (`$1, $2, …`) throughout, no string interpolation.
- **DATE columns stay as strings.** A custom `pg` type parser stops `DATE` values from shifting a day when they're converted to JS `Date` objects.
- **Traceability.** An `exceptid` column on `ServReq` links each repaired row back to the exception it came from.

## 🛠️ Improvements I'd make today
- Make the load **idempotent** (e.g. a unique constraint on `ServReq.exceptid` + `ON CONFLICT DO NOTHING`) so a rerun can't create duplicates
- Use the database clock (`CURRENT_TIMESTAMP`) for `fixstamp` instead of the client clock
- Replace the carry-forward date with an explicit, logged default so filled-in dates are auditable
- Add unit tests for `fixRecord` covering every repair and failure path
- Read `CURRENT_YEAR` from config instead of hard-coding it

## ▶️ Run it
Requires Node.js 18+.
```bash
npm install
cp .env.example .env   # fill in connection details
set -a && source .env && set +a
npm start
```
Run `npm run typecheck` to typecheck with `tsc --strict`.

## 🔗 Related
[postgres-etl-pipeline](https://github.com/johnshaw-data/postgres-etl-pipeline): an incremental multi-site sales ETL (SQL Server → PostgreSQL) in Python.

## 🧰 Stack
TypeScript · Node.js · node-postgres (`pg`) · tsx · PostgreSQL · SQL
