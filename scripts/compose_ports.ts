#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const COMPOSE_FILENAMES: Record<string, true> = {
  "compose.yaml": true,
  "compose.yml": true,
  "docker-compose.yaml": true,
  "docker-compose.yml": true,
};

type UsageEntry = {
  service: string;
  filePath: string;
  raw: string;
};

type Row = {
  port: number;
  protocol: string;
  entries: UsageEntry[];
};

type CliArgs = {
  root: string;
  checkPorts: number[] | null;
  noConflicts: boolean;
};

const toPosix = (value: string): string => value.split(path.sep).join("/");

function usageAndExit(code: number): never {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(
    [
      "Usage: ./scripts/compose_ports.ts [options]",
      "",
      "Options:",
      "  --root <dir>        Directory to scan (default: docker)",
      "  --check <p1 p2...>  Check specific host ports and exit 1 if any are used",
      "  --no-conflicts      Skip conflict report",
      "  -h, --help          Show this help",
      "",
    ].join("\n"),
  );
  process.exit(code);
}

function parseCli(argv: string[]): CliArgs {
  const args: CliArgs = { root: "docker", checkPorts: null, noConflicts: false };
  const fail = (message: string): never => {
    console.error(`error: ${message}`);
    usageAndExit(2);
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "-h" || token === "--help") usageAndExit(0);

    if (token === "--no-conflicts") {
      args.noConflicts = true;
      continue;
    }

    if (token === "--root") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) fail("--root requires a directory argument");
      args.root = next;
      continue;
    }

    if (token === "--check") {
      const ports: number[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        const port = Number.parseInt(argv[++i], 10);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          fail(`invalid port in --check: ${argv[i]}`);
        }
        ports.push(port);
      }
      if (ports.length === 0) fail("--check requires at least one port");
      args.checkPorts = ports;
      continue;
    }

    fail(`unknown argument: ${token}`);
  }

  return args;
}

function findComposeFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => path.basename(file) in COMPOSE_FILENAMES)
    .map((file) => path.join(root, file))
    .sort((a, b) => a.localeCompare(b));
}

const normalizeProtocol = (value: unknown): string =>
  String(value ?? "tcp").trim().toLowerCase() || "tcp";

function parsePortToken(token: unknown): number[] {
  const text = String(token ?? "").trim();
  if (/^\d+$/.test(text)) return [Number(text)];

  if (!/^\d+-\d+$/.test(text)) return [];
  const [start, end] = text.split("-").map(Number);
  return end < start ? [] : Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

// Published host ports from a short-syntax mapping like "127.0.0.1:8080:80/udp"
// (host-ip:host-port:container-port). The published side is the middle segment.
function iterServicePorts(ports: unknown): Array<{ numbers: number[]; protocol: string; raw: string }> {
  if (!Array.isArray(ports)) return [];

  return ports.flatMap((item) => {
    if (typeof item === "string") {
      const raw = item.trim();
      const slash = raw.lastIndexOf("/");
      const mapping = slash === -1 ? raw : raw.slice(0, slash);
      const protocol = slash === -1 ? "tcp" : raw.slice(slash + 1);

      if (!mapping.includes(":")) return [];
      const hostSide = mapping.slice(0, mapping.lastIndexOf(":"));
      const numbers = parsePortToken(hostSide.slice(hostSide.lastIndexOf(":") + 1));
      return numbers.length ? [{ numbers, protocol: normalizeProtocol(protocol), raw: item }] : [];
    }

    if (item && typeof item === "object" && !Array.isArray(item)) {
      const { published, protocol } = item as { published?: unknown; protocol?: unknown };
      const numbers = parsePortToken(published);
      return numbers.length
        ? [{ numbers, protocol: normalizeProtocol(protocol), raw: JSON.stringify(item) }]
        : [];
    }

    return [];
  });
}

function collectRows(root: string): { rows: Row[]; warnings: string[] } {
  const byKey = new Map<string, Row>();
  const warnings: string[] = [];

  for (const file of findComposeFiles(root)) {
    let content: unknown;
    try {
      content = YAML.parse(readFileSync(file, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${file}: failed to parse YAML (${message})`);
      continue;
    }

    if (!content || typeof content !== "object" || Array.isArray(content)) continue;
    const services = (content as Record<string, unknown>).services;
    if (!services || typeof services !== "object" || Array.isArray(services)) continue;

    for (const [service, serviceDef] of Object.entries(services as Record<string, unknown>)) {
      if (!serviceDef || typeof serviceDef !== "object" || Array.isArray(serviceDef)) continue;

      for (const { numbers, protocol, raw } of iterServicePorts((serviceDef as Record<string, unknown>).ports)) {
        for (const port of numbers) {
          const key = `${port}/${protocol}`;
          const row = byKey.get(key) ?? { port, protocol, entries: [] };
          if (!row.entries.some((entry) => entry.service === service && entry.filePath === file)) {
            row.entries.push({ service, filePath: file, raw });
            byKey.set(key, row);
          }
        }
      }
    }
  }

  const rows = [...byKey.values()].sort((a, b) =>
    a.port === b.port ? a.protocol.localeCompare(b.protocol) : a.port - b.port,
  );
  return { rows, warnings };
}

const formatEntries = (root: string, entries: UsageEntry[]): string =>
  entries
    .map((entry) => `${entry.service}@${toPosix(path.relative(root, entry.filePath))}`)
    .sort()
    .join(", ");

function printUsageTable(rows: Row[], root: string): void {
  console.log("PORT  PROTO  SERVICES  DETAILS");
  console.log("----  -----  --------  -------");

  for (const row of rows) {
    const services = new Set(row.entries.map((entry) => entry.service));
    console.log(
      `${String(row.port).padEnd(4)}  ${row.protocol.padEnd(5)}  ${String(services.size).padEnd(8)}  ${formatEntries(root, row.entries)}`,
    );
  }
}

function printConflicts(rows: Row[], root: string): void {
  // Conflict = same port/proto claimed by more than one service+file pair.
  const conflicts = rows.filter((row) => {
    const owners = new Set(row.entries.map((entry) => `${entry.service}|${entry.filePath}`));
    return owners.size > 1;
  });

  if (conflicts.length === 0) {
    console.log("\nNo port conflicts detected.");
    return;
  }

  console.log("\nConflicts:");
  for (const row of conflicts) {
    console.log(`- ${row.port}/${row.protocol}: ${formatEntries(root, row.entries)}`);
  }
}

function printPortChecks(rows: Row[], ports: number[], root: string): number {
  let inUse = false;

  for (const port of ports) {
    const matches = rows.filter((row) => row.port === port);
    if (matches.length === 0) {
      console.log(`${port}: free`);
      continue;
    }

    inUse = true;
    const details = matches.map((row) => `${row.protocol} -> ${formatEntries(root, row.entries)}`).join("; ");
    console.log(`${port}: in use (${details})`);
  }

  if (!inUse) {
    console.log("All checked ports are free.");
    return 0;
  }

  return 1;
}

function main(): number {
  const args = parseCli(process.argv.slice(2));
  const root = path.resolve(args.root);

  try {
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    console.error(`error: root path does not exist or is not a directory: ${root}`);
    return 2;
  }

  const { rows, warnings } = collectRows(root);
  if (warnings.length > 0) {
    console.error("Warnings:");
    for (const warning of warnings) console.error(`- ${warning}`);
  }

  if (args.checkPorts) return printPortChecks(rows, args.checkPorts, root);

  printUsageTable(rows, root);
  if (!args.noConflicts) printConflicts(rows, root);

  return 0;
}

process.exit(main());
