export { GraphConnection } from "./connection.js";
export {
  initSchema,
  NODE_TABLE_DDL,
  REL_TABLE_DDL,
  NODE_TABLES,
  REL_TABLES,
} from "./schema.js";
export {
  migrateSchemaColumns,
  detectPendingColumnMigrations,
  parseDeclaredColumns,
} from "./schema-migration.js";
export type {
  ColumnDef,
  DeclaredTable,
  ColumnMigration,
  SchemaMigrationReport,
} from "./schema-migration.js";
export { backupDbFile } from "./backup.js";
export type * from "./types.js";
