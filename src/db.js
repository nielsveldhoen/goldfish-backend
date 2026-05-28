import pkg from "pg";

const { Pool, types } = pkg;

// DATE (OID 1082) terugsturen als string zodat "2026-05-15" niet naar UTC midnight wordt geconverteerd
types.setTypeParser(1082, (val) => val);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});