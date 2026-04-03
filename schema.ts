import { pgTable, serial, json } from "drizzle-orm/pg-core";

export const testTable = pgTable("test_json", {
  id: serial("id").primaryKey(),
  value: json("value").notNull(),
});
