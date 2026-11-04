// John Shaw
// Exception-log repair ETL — TypeScript implementation
//
// Setup:  npm install
// Run:    cp .env.example .env, fill it in, then: set -a && source .env && set +a && npm start

import { Client, types } from "pg";

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Date objects
types.setTypeParser(1082, (v) => v);

const CURRENT_YEAR = 2024;

interface ExceptionRow { exceptid: number; record: string; fixstamp: Date | null }
interface Tenant { tenantid: number; fname: string; lname: string }
interface ReqType { rtid: number; typename: string }
interface Building { bldgid: number; bldgname: string; unitrange: string }

interface FixedRecord {
  tenantid: number;
  rtid: number;
  bldgid: number;
  reqdate: string;
  unit: number;
  reqdescription: string;
  exceptid: number;
}

type FixResult =
  | { ok: true; fixed: FixedRecord }
  | { ok: false; reason: string; values: string[] };

interface Lookups {
  tenants: Tenant[];
  rtidByType: Map<string, number>; // lowercased typename -> rtid
  buildings: Building[];
}

async function loadLookups(client: Client): Promise<Lookups> {
  const tenants = (await client.query<Tenant>("SELECT tenantid, fname, lname FROM Tenant")).rows;
  const reqTypes = (await client.query<ReqType>("SELECT rtid, typename FROM ReqType")).rows;
  const buildings = (await client.query<Building>("SELECT bldgid, bldgname, unitrange FROM Building")).rows;
  const rtidByType = new Map(reqTypes.map((r) => [r.typename.toLowerCase(), r.rtid]));
  return { tenants, rtidByType, buildings };
}

async function loadUnfixed(client: Client): Promise<ExceptionRow[]> {
  const res = await client.query<ExceptionRow>(
    "SELECT exceptid, record, fixstamp FROM ExceptionLog WHERE fixstamp IS NULL"
  );
  return res.rows;
}

/** Strict 'YYYY-MM-DD' check that also rejects impossible dates like 2024-02-31. */
function isValidDateInYear(value: string, year: number): boolean {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const real = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  return real && y === year;
}

/**
 * Step 5: validate / repair one ExceptionLog record.
 * `state.lastValidDate` carries forward between records to fill in missing dates.
 */
function fixRecord(row: ExceptionRow, lk: Lookups, state: { lastValidDate: string | null }): FixResult {
  // 5b/5c: split the pipe-delimited record
  const values = row.record.split("|").map((x) => x.trim());
  const fail = (reason: string): FixResult => ({ ok: false, reason, values });

  // 5d: name
  const nameValue = values[0] ?? "";
  if (!nameValue.includes(" ")) return fail("One Name");

  const nameParts = nameValue.split(/\s+/);
  const first = nameParts[0];
  const last = nameParts[nameParts.length - 1];
  const tenant = lk.tenants.find((t) => t.fname === first && t.lname === last);
  if (!tenant) return fail("Unknown Name");

  // 5e: request type
  const typeValue = (values[1] ?? "").toLowerCase();
  let rtid = typeValue === "" ? undefined : lk.rtidByType.get(typeValue);
  if (rtid === undefined) {
    const description = values[5] ?? "";
    if (description.includes("Internet")) rtid = lk.rtidByType.get("connectivity");
    else if (typeValue === "outlets") rtid = lk.rtidByType.get("electrical");
    if (rtid === undefined) return fail("Unknown Type");
  }

  // 5f/5h: unit and building
  const unitValue = values[4] ?? "";
  if (unitValue === "") return fail("No Unit");
  if (!/^[+-]?\d+$/.test(unitValue)) return fail("Bad Unit");
  const unit = Number(unitValue);
  if (unit < 101 || unit > 898) return fail("Bad Unit");

  const buildingValue = (values[2] ?? "").toLowerCase();
  let building =
    buildingValue === "" ? undefined : lk.buildings.find((b) => b.bldgname.toLowerCase() === buildingValue);
  if (!building) {
    // Infer the building from the unit number
    building = lk.buildings.find((b) => {
      const rng = b.unitrange.split("-");
      return rng.length === 2 && Number(rng[0]) <= unit && unit <= Number(rng[1]);
    });
    if (!building) return fail("Bad Unit");
  }

  // 5g: date (fall back to the last valid date seen)
  const dateValue = values[3] ?? "";
  let reqdate: string;
  if (isValidDateInYear(dateValue, CURRENT_YEAR)) {
    reqdate = dateValue;
    state.lastValidDate = dateValue;
  } else if (state.lastValidDate !== null) {
    reqdate = state.lastValidDate;
  } else {
    return fail("No Date");
  }

  // 5i: description
  const reqdescription = values[5] ?? "";
  if (reqdescription === "") return fail("No Description");

  return {
    ok: true,
    fixed: {
      tenantid: tenant.tenantid,
      rtid,
      bldgid: building.bldgid,
      reqdate,
      unit,
      reqdescription,
      exceptid: row.exceptid,
    },
  };
}

function describe(f: FixedRecord): string {
  return (
    `tenantid=${f.tenantid}, rtid=${f.rtid}, bldgid=${f.bldgid}, reqdate=${f.reqdate}, ` +
    `unit=${f.unit}, reqdescription=${f.reqdescription}, exceptid=${f.exceptid}`
  );
}

async function main(): Promise<void> {
  // Credentials come from the environment rather than being hard-coded.
  const client = new Client({
    database: process.env.PGDATABASE ?? "loftsvc",
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
  });
  await client.connect();

  try {
    // Step 2: unfixed exception records
    let exceptions = await loadUnfixed(client);
    console.table(exceptions);

    // Step 3: observations
    console.log("a. Rhonda Carter: Building is null. Joining Tenant, ServReq, and Building Table reveals relationship between names and buildings.");
    console.log("b. Willie Green: Type is null. Consider if null then type = 'other' general approach. Alternatively, the comments could be used to infer the issue. Perhaps create a list of most frequent words for each type category and use that.");
    console.log("c. Jerry Massey: Missing date. Maybe use a sentinel value for missing dates.");
    console.log("d. Gabriela Carter: 'outlets' is not a valid type. Use the same fix as the issue from Willie Green's record.");

    // Step 4a: add exceptid column if needed
    await client.query("ALTER TABLE ServReq ADD COLUMN IF NOT EXISTS exceptid INTEGER");

    // Step 4d: first three records
    const firstThree = await client.query("SELECT srid, exceptid FROM ServReq ORDER BY srid LIMIT 3");
    console.table(firstThree.rows);

    // Step 5: dry run - show what can and can't be fixed
    let lookups = await loadLookups(client);
    let state = { lastValidDate: null as string | null };
    for (const row of exceptions) {
      const result = fixRecord(row, lookups, state);
      if (result.ok) console.log(describe(result.fixed));
      else console.log(`Can't Fix ${result.reason} ${JSON.stringify(result.values)}`);
    }

    // Step 6: write fixed records to ServReq and stamp ExceptionLog
    exceptions = await loadUnfixed(client);
    lookups = await loadLookups(client);
    state = { lastValidDate: null };
    for (const row of exceptions) {
      const result = fixRecord(row, lookups, state);
      if (!result.ok) {
        console.log(`Can't Fix ${JSON.stringify(result.values)}`);
        continue;
      }
      const f = result.fixed;
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO ServReq (tenantid, rtid, bldgid, reqdate, unit, reqdescription, exceptid)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [f.tenantid, f.rtid, f.bldgid, f.reqdate, f.unit, f.reqdescription, f.exceptid]
        );
        await client.query("UPDATE ExceptionLog SET fixstamp = $1 WHERE exceptid = $2", [new Date(), f.exceptid]);
        await client.query("COMMIT");
        console.log(`Record Added: ${describe(f)}`);
      } catch (e) {
        await client.query("ROLLBACK");
        console.log(`Error inserting record ${JSON.stringify(row.record.split("|").map((x) => x.trim()))}: ${e}`);
      }
    }

    // Step 7: records added to ServReq from the ExceptionLog
    const servReq = await client.query(
      `SELECT srid, tenantid, rtid, bldgid, reqdate, unit, exceptid
       FROM ServReq WHERE exceptid IS NOT NULL ORDER BY srid`
    );
    console.table(servReq.rows);

    // Step 8: ExceptionLog records that were fixed
    const fixedLog = await client.query(
      `SELECT exceptid, record, fixstamp
       FROM ExceptionLog WHERE fixstamp IS NOT NULL ORDER BY exceptid`
    );
    console.table(fixedLog.rows);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
