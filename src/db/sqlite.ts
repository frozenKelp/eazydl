import { Database as BunDatabase } from 'bun:sqlite';

type RunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

class Statement<Params extends unknown[] = unknown[], Result = unknown> {
  constructor(private readonly statement: ReturnType<BunDatabase['query']>) {}

  run(...params: Params): RunResult {
    return (this.statement.run as (...args: unknown[]) => unknown)(...params) as RunResult;
  }

  get(...params: Params): Result | undefined {
    return (this.statement.get as (...args: unknown[]) => unknown)(...params) as Result | undefined;
  }

  all(...params: Params): Result[] {
    return (this.statement.all as (...args: unknown[]) => unknown)(...params) as Result[];
  }
}

export class SqliteDatabase {
  private readonly database: BunDatabase;
  private transactionDepth = 0;

  constructor(filename: string) {
    this.database = new BunDatabase(filename);
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  pragma(sql: string): unknown {
    return this.database.query(`PRAGMA ${sql}`).all();
  }

  prepare<Params extends unknown[] = unknown[], Result = unknown>(sql: string): Statement<Params, Result> {
    return new Statement<Params, Result>(this.database.query(sql));
  }

  transaction<Args extends unknown[], ReturnValue>(
    fn: (...args: Args) => ReturnValue,
  ): (...args: Args) => ReturnValue {
    return (...args: Args) => {
      const outermost = this.transactionDepth === 0;
      if (outermost) this.exec('BEGIN');
      this.transactionDepth++;
      try {
        const result = fn(...args);
        this.transactionDepth--;
        if (outermost) this.exec('COMMIT');
        return result;
      } catch (err) {
        this.transactionDepth--;
        if (outermost) this.exec('ROLLBACK');
        throw err;
      }
    };
  }
}
