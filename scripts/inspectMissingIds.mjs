import "dotenv/config";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const ids = ["2120","899","1840","1875","298","109","881","767","1696"];
const placeholders = ids.map(() => "?").join(",");

const [orderRows] = await conn.execute(
  `SELECT customerExternalId, COUNT(*) AS orders, MAX(placedAt) AS lastSeen
   FROM posOrders WHERE source='cleancloud' AND customerExternalId IN (${placeholders})
   GROUP BY customerExternalId`, ids);
console.log("Orders for these IDs:", orderRows);

const [custRows] = await conn.execute(
  `SELECT externalId, name, phoneE164 FROM posCustomers
   WHERE source='cleancloud' AND externalId IN (${placeholders})`, ids);
console.log("Customers for these IDs:", custRows);

const [orderStats] = await conn.execute(`
  SELECT
    COUNT(DISTINCT o.customerExternalId) AS distinct_order_customers,
    COUNT(DISTINCT c.externalId) AS distinct_mirror_customers,
    SUM(c.externalId IS NULL) AS orders_for_unmirrored_customers
  FROM (SELECT DISTINCT customerExternalId FROM posOrders WHERE source='cleancloud') o
  LEFT JOIN posCustomers c ON c.source='cleancloud' AND c.externalId = o.customerExternalId
`);
console.log("Coverage stats:", orderStats[0]);

await conn.end();
