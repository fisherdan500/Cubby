type AggregateCommand = {
  readonly kind: "aggregate";
  readonly from: string;
  readonly to: string;
};

type HelpCommand = { readonly kind: "help" };
type ParsedCommand = AggregateCommand | HelpCommand;

type AggregateRow = {
  readonly layer: string;
  readonly state: string;
  readonly coarseTimeBucket: Date | string;
  readonly incidentCount: bigint | number;
};

type OperatorDatabase = {
  aggregate(command: AggregateCommand): Promise<readonly AggregateRow[]>;
};

export function parseSecurityOperatorCommand(args: readonly string[]): ParsedCommand {
  const [operation, ...rest] = args;
  if (operation === "--help" || operation === "-h") {
    if (rest.length !== 0) throw new Error("security_operator_command_invalid");
    return { kind: "help" };
  }
  if (operation === "aggregate") {
    if (rest.length !== 4 || rest[0] !== "--from" || rest[2] !== "--to") throw new Error("security_operator_command_invalid");
    const from = rest[1];
    const to = rest[3];
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("security_operator_command_invalid");
    const fromTime = Date.parse(`${from}T00:00:00.000Z`);
    const toTime = Date.parse(`${to}T00:00:00.000Z`);
    if (new Date(fromTime).toISOString().slice(0,10) !== from || new Date(toTime).toISOString().slice(0,10) !== to || fromTime >= toTime || toTime-fromTime > 31*24*60*60*1000) throw new Error("security_operator_command_invalid");
    return { kind: "aggregate", from, to };
  }
  throw new Error("security_operator_command_invalid");
}

export async function runSecurityOperatorCommand(
  args: readonly string[],
  loadDatabase: () => Promise<OperatorDatabase> = loadSecurityOperatorDatabase
): Promise<{ readonly exitCode: 0 | 1; readonly stream: "stdout" | "stderr"; readonly output: string }> {
  let command: ParsedCommand;
  try {
    command = parseSecurityOperatorCommand(args);
  } catch {
    return { exitCode: 1, stream: "stderr", output: "security_operator_command_invalid" };
  }
  if (command?.kind === "help") {
    return { exitCode: 0, stream: "stdout", output: "Usage: security-operator aggregate --from YYYY-MM-DD --to YYYY-MM-DD" };
  }


  try {
    const database = await loadDatabase();
    const rows = await database.aggregate(command);
    return {
      exitCode: 0,
      stream: "stdout",
      output: JSON.stringify({
        schemaVersion: 1,
        from: command.from,
        to: command.to,
        aggregates: rows.map((row) => ({
          layer: row.layer,
          state: row.state,
          coarseTimeBucket: toUtcDate(row.coarseTimeBucket),
          incidentCount: Number(row.incidentCount)
        }))
      })
    };
  } catch {
    return { exitCode: 1, stream: "stderr", output: "security_operator_operation_failed" };
  }
}


function toUtcDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

async function loadSecurityOperatorDatabase(): Promise<OperatorDatabase> {
  const databaseUrl = process.env.SECURITY_OPERATOR_DATABASE_URL;
  if (!databaseUrl) throw new Error();
  const parsed = new URL(databaseUrl);
  if (decodeURIComponent(parsed.username) !== "cubby_security_operator" || !decodeURIComponent(parsed.password)) {
    throw new Error();
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  return {
    async aggregate(command) {
      try {
        return await prisma.$queryRawUnsafe<AggregateRow[]>(
          'SELECT "layer","state","coarseTimeBucket","incidentCount" FROM public."read_global_security_operator_aggregate"($1::date,$2::date)',
          command.from,
          command.to
        );
      } finally {
        await prisma.$disconnect();
      }
    }
  };
}

export function writeSecurityOperatorCommandResult(result: { readonly exitCode: 0 | 1; readonly stream: "stdout" | "stderr"; readonly output: string }, streams: Pick<typeof process,"stdout"|"stderr">=process) {
  (result.stream === "stdout" ? streams.stdout : streams.stderr).write(`${result.output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSecurityOperatorCommand(process.argv.slice(2)).then((result) => {
    writeSecurityOperatorCommandResult(result);
    process.exitCode=result.exitCode;
  });
}
import { pathToFileURL } from "node:url";
