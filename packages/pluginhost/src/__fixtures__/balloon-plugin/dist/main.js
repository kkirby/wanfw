process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'balloon') {
      // Deliberately blow past the memMb limit so the parent's `prlimit
      // --as` wrapper (or V8 itself) kills this process.
      const chunks = [];
      while (true) {
        chunks.push(Buffer.alloc(10 * 1024 * 1024, 1));
      }
    }
  }
});
