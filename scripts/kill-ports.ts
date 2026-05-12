/**
 * Frees the dev ports we use (3000, 4000) before starting servers. Useful
 * after a crashed `desktop:dev` session leaves orphaned node.exe processes
 * holding the sockets.
 *
 *   npm run kill           # kill 3000 + 4000
 *   npm run kill 3000      # kill only one port
 */
import { execSync } from 'node:child_process';

const ports = process.argv.slice(2).map(Number).filter(Number.isFinite);
const targets = ports.length ? ports : [3000, 4000];

function killOn(port: number) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8' });
      const pids = new Set<string>();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/\s+(\d+)$/);
        if (m && m[1] && m[1] !== '0') pids.add(m[1]);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch { /* already gone */ }
      }
      console.log(`[kill] port ${port}: ${pids.size ? `killed ${[...pids].join(', ')}` : 'nothing listening'}`);
    } else {
      try { execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: 'ignore' }); } catch { /* nothing */ }
      console.log(`[kill] port ${port}: cleared`);
    }
  } catch {
    console.log(`[kill] port ${port}: nothing listening`);
  }
}

for (const port of targets) killOn(port);
