import "dotenv/config";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const [[totals]] = await conn.execute(`
  SELECT
    COUNT(*) AS total,
    SUM(name IS NULL OR name='') AS missing_name,
    SUM(phoneE164 IS NOT NULL AND phoneE164<>'') AS has_phone
  FROM posCustomers
`);
console.log("posCustomers:", totals);

const [[orphan]] = await conn.execute(`
  SELECT COUNT(DISTINCT o.customerExternalId) AS orphan_count
  FROM posOrders o
  LEFT JOIN posCustomers c ON c.externalId = o.customerExternalId
  WHERE c.externalId IS NULL AND o.customerExternalId IS NOT NULL AND o.customerExternalId<>''
`);
console.log("orders referencing customers NOT in mirror:", orphan);

const [[customer196]] = await conn.execute(`
  SELECT externalId, name, phoneE164,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.Name')) AS rp_Name,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.customerName')) AS rp_customerName,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.Tel')) AS rp_Tel,
    JSON_UNQUOTE(JSON_EXTRACT(rawPayload, '$.Email')) AS rp_Email,
    rawPayload IS NOT NULL AS has_raw
  FROM posCustomers
  WHERE externalId='196'
`);
console.log("\nCustomer 196 (the one cited as '단골 고객 196번님'):");
console.log(customer196);

const [topByOrders] = await conn.execute(`
  SELECT c.externalId, c.name, c.phoneE164, COUNT(*) AS order_count, SUM(o.totalCents) AS total_cents
  FROM posOrders o
  LEFT JOIN posCustomers c ON c.externalId = o.customerExternalId
  WHERE o.customerExternalId IS NOT NULL AND o.customerExternalId<>''
  GROUP BY c.externalId, c.name, c.phoneE164
  ORDER BY total_cents DESC
  LIMIT 10
`);
console.log("\nTop 10 spenders & their mirror name/phone status:");
for (const r of topByOrders) console.log(JSON.stringify(r));

await conn.end();
