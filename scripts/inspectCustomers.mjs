/**
 * One-off inspector: dump 5 customer rows where name is NULL/empty,
 * showing what the raw CleanCloud payload had for Name fields.
 *
 * Usage:
 *   pnpm tsx scripts/inspectCustomers.mjs
 */
import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const conn = await mysql.createConnection(url);
const [rows] = await conn.execute(`
  SELECT externalId, name, phoneE164,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.Name')) AS rp_Name,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.customerName')) AS rp_customerName,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.Tel')) AS rp_Tel,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.Email')) AS rp_Email,
    JSON_KEYS(rawPayload) AS rp_keys
  FROM posCustomers
  WHERE source='cleancloud' AND (name IS NULL OR name='')
  ORDER BY id DESC
  LIMIT 5
`);
console.log("Missing-name samples:");
for (const r of rows) {
  console.log(JSON.stringify(r, null, 2));
}

const [stats] = await conn.execute(`
  SELECT
    COUNT(*) AS total,
    SUM(name IS NULL OR name='') AS missing_name,
    SUM(name IS NOT NULL AND name<>'') AS has_name,
    SUM(phoneE164 IS NOT NULL) AS has_phone,
    SUM(rawPayload IS NOT NULL) AS has_raw
  FROM posCustomers WHERE source='cleancloud'
`);
console.log("\nStats:", stats[0]);

const [withName] = await conn.execute(`
  SELECT externalId, name, phoneE164,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.Name')) AS rp_Name,
    JSON_KEYS(rawPayload) AS rp_keys
  FROM posCustomers
  WHERE source='cleancloud' AND name IS NOT NULL AND name<>''
  ORDER BY id DESC
  LIMIT 3
`);
console.log("\nWith-name samples:");
for (const r of withName) console.log(JSON.stringify(r, null, 2));

await conn.end();
