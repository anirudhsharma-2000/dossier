import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

// On Vercel, src/lib/prisma.ts hands the adapter its own pg Pool (so
// attachDatabasePool can release it). The adapter only uses a pool from the
// same pg package as ours: with a second copy of pg in node_modules it takes
// the pool for settings instead, and every query fails. `yarn dedupe pg`
// fixes that.
describe("the database pool on Vercel", () => {
  it("is used by the Prisma adapter as it is", async () => {
    const pool = new Pool({ connectionString: "postgresql://localhost:5432/none" });
    const adapter = new PrismaPg(pool) as unknown as { externalPool?: Pool };
    expect(adapter.externalPool).toBe(pool);
    await pool.end();
  });
});
