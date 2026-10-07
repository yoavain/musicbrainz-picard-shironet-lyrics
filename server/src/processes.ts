// The process list, for the browser leak rules: parent PIDs, memory and start times.
// Windows: one PowerShell CIM query. Linux: /proc. Command lines are not used: they were
// not readable through CIM on the development machine.

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  rssBytes: number;
  /** Private memory (Windows PrivatePageCount, Linux RssAnon); falls back to rssBytes. */
  privateBytes: number;
  /** An opaque start-time string; equal strings mean the same process. */
  start: string;
}

const WINDOWS_QUERY =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,'
  + "@{n='Start';e={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }}} "
  + '| ConvertTo-Json -Compress';

async function listWindows(): Promise<ProcessInfo[]> {
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], {
    windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    ProcessId: number; ParentProcessId: number; WorkingSetSize: number | null; PrivatePageCount: number | null; Start: string;
  }>;
  return rows.map((row) => ({
    pid: row.ProcessId, ppid: row.ParentProcessId, rssBytes: Number(row.WorkingSetSize ?? 0),
    privateBytes: Number(row.PrivatePageCount ?? row.WorkingSetSize ?? 0), start: row.Start,
  }));
}

/** RssAnon from /proc/<pid>/status: resident memory not shared with files, in bytes. */
function linuxPrivateBytes(pid: string): number | null {
  try {
    const match = /^RssAnon:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function listLinux(): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // Fields after the command name, which is in parentheses and may contain spaces.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const rssBytes = Number(fields[21]) * 4096;
      result.push({ pid: Number(name), ppid: Number(fields[1]), rssBytes, privateBytes: linuxPrivateBytes(name) ?? rssBytes, start: fields[19] });
    } catch {
      // the process ended while we read
    }
  }
  return result;
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  return process.platform === 'win32' ? listWindows() : listLinux();
}

export function descendants(all: ProcessInfo[], pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const info of all) {
    if (info.pid === info.ppid) continue;
    (children.get(info.ppid) ?? children.set(info.ppid, []).get(info.ppid)!).push(info.pid);
  }
  const found: number[] = [];
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (found.includes(next)) continue;
    found.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return found;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kills a process and all its descendants. A process that is already gone is fine. */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await run('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    } catch {
      // exit code 128: no such process
    }
    return;
  }
  const all = listLinux();
  const tree = [pid, ...descendants(all, pid)];
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader, or gone */ }
  for (const member of tree) {
    try { process.kill(member, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Total private memory of a process and its descendants, or null when it is gone. */
export async function treeMemory(pid: number): Promise<number | null> {
  const all = await listProcesses();
  const root = all.find((info) => info.pid === pid);
  if (!root) return null;
  const members = new Set([pid, ...descendants(all, pid)]);
  return all.filter((info) => members.has(info.pid)).reduce((sum, info) => sum + info.privateBytes, 0);
}
