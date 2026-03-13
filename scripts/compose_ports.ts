#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const COMPOSE_FILENAMES = new Set([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
]);

const RANGE_PATTERN = /^\d+-\d+$/;

type UsageEntry = {
  service: string;
  filePath: string;
  raw: string;
};

type CliArgs = {
  root: string;
  checkPorts: number[] | null;
  noConflicts: boolean;
};

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

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
  let root = "docker";
  let checkPorts: number[] | null = null;
  let noConflicts = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token === "-h" || token === "--help") {
      usageAndExit(0);
    }

    if (token === "--root") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("error: --root requires a directory argument");
        usageAndExit(2);
      }
      root = next;
      i++;
      continue;
    }

    if (token === "--check") {
      const ports: number[] = [];
      let j = i + 1;
      while (j < argv.length && !argv[j].startsWith("-")) {
        const parsed = Number.parseInt(argv[j], 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
          console.error(`error: invalid port in --check: ${argv[j]}`);
          usageAndExit(2);
        }
        ports.push(parsed);
        j++;
      }

      if (ports.length === 0) {
        console.error("error: --check requires at least one port");
        usageAndExit(2);
      }

      checkPorts = ports;
      i = j - 1;
      continue;
    }

    if (token === "--no-conflicts") {
      noConflicts = true;
      continue;
    }

    console.error(`error: unknown argument: ${token}`);
    usageAndExit(2);
  }

  return { root, checkPorts, noConflicts };
}

function findComposeFiles(root: string): string[] {
  const files: string[] = [];

  function walk(current: string): void {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (entry.isFile() && COMPOSE_FILENAMES.has(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  walk(root);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function normalizeProtocol(raw: unknown): string {
  const protocol = String(raw ?? "tcp").trim().toLowerCase();
  return protocol || "tcp";
}

function parsePortToken(token: unknown): number[] {
  const text = String(token ?? "").trim();
  if (!text) {
    return [];
  }

  if (/^\d+$/.test(text)) {
    return [Number.parseInt(text, 10)];
  }

  if (RANGE_PATTERN.test(text)) {
    const [startText, endText] = text.split("-", 2);
    const start = Number.parseInt(startText, 10);
    const end = Number.parseInt(endText, 10);
    if (end < start) {
      return [];
    }
    return Array.from({ length: end - start + 1 }, (_, idx) => start + idx);
  }

  return [];
}

function extractPublishedFromShortPort(portSpec: string): { numbers: number[]; protocol: string } {
  const raw = String(portSpec).trim();
  if (!raw) {
    return { numbers: [], protocol: "tcp" };
  }

  const slashIndex = raw.lastIndexOf("/");
  const mapping = slashIndex === -1 ? raw : raw.slice(0, slashIndex);
  const protocol = slashIndex === -1 ? "tcp" : raw.slice(slashIndex + 1);

  if (!mapping.includes(":")) {
    return { numbers: [], protocol: normalizeProtocol(protocol) };
  }

  const hostSide = mapping.slice(0, mapping.lastIndexOf(":"));
  const published = hostSide.slice(hostSide.lastIndexOf(":") + 1).trim();
  return {
    numbers: parsePortToken(published),
    protocol: normalizeProtocol(protocol),
  };
}

function iterServicePorts(ports: unknown): Array<{ numbers: number[]; protocol: string; raw: string }> {
  if (!Array.isArray(ports)) {
    return [];
  }

  const result: Array<{ numbers: number[]; protocol: string; raw: string }> = [];

  for (const item of ports) {
    if (typeof item === "string") {
      const parsed = extractPublishedFromShortPort(item);
      if (parsed.numbers.length > 0) {
        result.push({ ...parsed, raw: item });
      }
      continue;
    }

    if (item && typeof item === "object" && !Array.isArray(item)) {
      const protocol = normalizeProtocol((item as Record<string, unknown>).protocol);
      const numbers = parsePortToken((item as Record<string, unknown>).published);
      if (numbers.length > 0) {
        result.push({
          numbers,
          protocol,
          raw: JSON.stringify(item),
        });
      }
    }
  }

  return result;
}

function makeUsageKey(port: number, protocol: string): string {
  return `${port}/${protocol}`;
}

function collectPortUsage(root: string): { usage: Map<string, UsageEntry[]>; warnings: string[] } {
  const usage = new Map<string, UsageEntry[]>();
  const warnings: string[] = [];

  for (const composeFile of findComposeFiles(root)) {
    let content: unknown;
    try {
      content = YAML.parse(readFileSync(composeFile, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${composeFile}: failed to parse YAML (${message})`);
      continue;
    }

    if (!content || typeof content !== "object" || Array.isArray(content)) {
      continue;
    }

    const services = (content as Record<string, unknown>).services;
    if (!services || typeof services !== "object" || Array.isArray(services)) {
      continue;
    }

    for (const [serviceName, serviceDef] of Object.entries(services as Record<string, unknown>)) {
      if (!serviceDef || typeof serviceDef !== "object" || Array.isArray(serviceDef)) {
        continue;
      }

      const ports = (serviceDef as Record<string, unknown>).ports;
      for (const item of iterServicePorts(ports)) {
        for (const port of item.numbers) {
          const key = makeUsageKey(port, item.protocol);
          const list = usage.get(key) ?? [];
          const duplicate = list.some(
            (entry) => entry.service === serviceName && entry.filePath === composeFile,
          );
          if (!duplicate) {
            list.push({ service: serviceName, filePath: composeFile, raw: item.raw });
            usage.set(key, list);
          }
        }
      }
    }
  }

  return { usage, warnings };
}

function splitUsageKey(key: string): { port: number; protocol: string } {
  const slash = key.lastIndexOf("/");
  return {
    port: Number.parseInt(key.slice(0, slash), 10),
    protocol: key.slice(slash + 1),
  };
}

function sortedUsageEntries(usage: Map<string, UsageEntry[]>): Array<{ port: number; protocol: string; entries: UsageEntry[] }> {
  return [...usage.entries()]
    .map(([key, entries]) => ({ ...splitUsageKey(key), entries }))
    .sort((a, b) => (a.port === b.port ? a.protocol.localeCompare(b.protocol) : a.port - b.port));
}

function printUsageTable(usage: Map<string, UsageEntry[]>, root: string): void {
  console.log("PORT  PROTO  SERVICES  DETAILS");
  console.log("----  -----  --------  -------");

  for (const row of sortedUsageEntries(usage)) {
    const services = new Set(row.entries.map((entry) => entry.service));
    const details = row.entries
      .map((entry) => `${entry.service}@${toPosix(path.relative(root, entry.filePath))}`)
      .sort()
      .join(", ");
    console.log(
      `${String(row.port).padEnd(4)}  ${row.protocol.padEnd(5)}  ${String(services.size).padEnd(8)}  ${details}`,
    );
  }
}

function printConflicts(usage: Map<string, UsageEntry[]>, root: string): void {
  const conflicts = sortedUsageEntries(usage).filter((row) => {
    const keys = new Set(row.entries.map((entry) => `${entry.service}|${entry.filePath}`));
    return keys.size > 1;
  });

  if (conflicts.length === 0) {
    console.log("\nNo port conflicts detected.");
    return;
  }

  console.log("\nConflicts:");
  for (const row of conflicts) {
    const details = row.entries
      .map((entry) => `${entry.service}@${toPosix(path.relative(root, entry.filePath))}`)
      .sort()
      .join(", ");
    console.log(`- ${row.port}/${row.protocol}: ${details}`);
  }
}

function printPortChecks(usage: Map<string, UsageEntry[]>, ports: number[], root: string): number {
  let inUse = false;

  for (const port of ports) {
    const matches = sortedUsageEntries(usage).filter((row) => row.port === port);
    if (matches.length === 0) {
      console.log(`${port}: free`);
      continue;
    }

    inUse = true;
    const details = matches
      .map((row) => {
        const owners = row.entries
          .map((entry) => `${entry.service}@${toPosix(path.relative(root, entry.filePath))}`)
          .sort()
          .join(", ");
        return `${row.protocol} -> ${owners}`;
      })
      .join("; ");
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
    if (!statSync(root).isDirectory()) {
      console.error(`error: root path does not exist or is not a directory: ${root}`);
      return 2;
    }
  } catch {
    console.error(`error: root path does not exist or is not a directory: ${root}`);
    return 2;
  }

  const { usage, warnings } = collectPortUsage(root);
  if (warnings.length > 0) {
    console.error("Warnings:");
    for (const warning of warnings) {
      console.error(`- ${warning}`);
    }
  }

  if (args.checkPorts) {
    return printPortChecks(usage, args.checkPorts, root);
  }

  printUsageTable(usage, root);
  if (!args.noConflicts) {
    printConflicts(usage, root);
  }

  return 0;
}

process.exit(main());
