/**
 * Apply src/db/schema.sql using the mssql driver.
 * Usage: SQL_CONNECTION_STRING=... npx ts-node is not required — run compiled or via tsx.
 * Prefer: node -r ts-node/register ... OR npm run apply-schema after build.
 */
import fs from "fs";
import path from "path";
import sql from "mssql";

async function main(): Promise<void> {
  const connectionString = process.env.SQL_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("SQL_CONNECTION_STRING is required");
  }

  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  const batches = schema
    .split(/^\s*GO\s*$/gim)
    .map((b) => b.trim())
    .filter(Boolean);

  const pool = await sql.connect(connectionString);
  try {
    for (const batch of batches) {
      await pool.request().query(batch);
    }
    console.log(`Applied ${batches.length} SQL batches from ${schemaPath}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
