/**
 * CREATE TABLE IF NOT EXISTS generated from the drizzle schema, so schema.ts stays the single
 * source of truth without a migration tool. Supports what schema.ts uses: column types,
 * NOT NULL and a single-column primary key. `addColumnsSql` upgrades a table an older
 * version created.
 */
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function createTableSql(table: PgTable): string {
  const { name, columns } = getTableConfig(table);
  const cols = columns.map((c) => {
    const parts = [ident(c.name), c.getSQLType()];
    if (c.primary) parts.push("PRIMARY KEY");
    else if (c.notNull) parts.push("NOT NULL");
    return `  ${parts.join(" ")}`;
  });
  return `CREATE TABLE IF NOT EXISTS ${ident(name)} (\n${cols.join(",\n")}\n)`;
}

/**
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for columns a table created by an older version
 * lacks. Each named column must exist in the drizzle definition and be nullable.
 */
export function addColumnsSql(table: PgTable, names: readonly string[]): string[] {
  const { name, columns } = getTableConfig(table);
  return names.map((n) => {
    const c = columns.find((col) => col.name === n);
    if (!c) throw new Error(`addColumnsSql: ${n} is not a column of ${name}`);
    if (c.notNull || c.primary) throw new Error(`addColumnsSql: ${n} must be nullable to be added to existing rows`);
    return `ALTER TABLE ${ident(name)} ADD COLUMN IF NOT EXISTS ${ident(c.name)} ${c.getSQLType()}`;
  });
}
