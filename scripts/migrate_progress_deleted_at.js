import "../src/config/env.js";
import { pool } from "../src/db.js";

await pool.query(`
  ALTER TABLE user_card_progress
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
`);

console.log("Migration complete: user_card_progress.deleted_at added.");
await pool.end();
