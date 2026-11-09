import { Migration } from '@mikro-orm/migrations';
import { financialSchemaDownSql, financialSchemaSql } from '../financial-schema.js';

export class Migration202611080001 extends Migration {
  override up(): void { this.addSql(financialSchemaSql); }
  override down(): void { this.addSql(financialSchemaDownSql); }
}
