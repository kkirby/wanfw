process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    JSON.parse(line);
    // crash: writes a distinctive, greppable stack-trace-shaped message to
    // stderr then exits nonzero, simulating an uncaught exception in a
    // plugin's entrypoint (the real thing child-runner.ts's stderr-tail
    // capture exists for).
    console.error('Error: simulated plugin crash for stderr-tail test\n    at task (main.js:1:1)');
    process.exit(1);
  }
});
