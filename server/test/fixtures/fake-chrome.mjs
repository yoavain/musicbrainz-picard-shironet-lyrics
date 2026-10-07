// Fake Chrome for the leak tests: argv carries --user-data-dir=<profile> and
// --remote-debugging-port=<port> like real Chrome. It starts a child process (like a
// renderer), answers /json/version on the port, and runs until killed. It speaks no CDP.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const value = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`)).slice(name.length + 3);
const profile = value('user-data-dir');
const port = Number(value('remote-debugging-port'));
const renderer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(join(profile, 'children.json'), JSON.stringify({ renderer: renderer.pid }));
writeFileSync(join(profile, 'lock-me.txt'), 'held open while running');
createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake-id` }));
}).listen(port, '127.0.0.1');
setInterval(() => {}, 1000);
