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
    // never-responds: intentionally does not reply, so the caller's wallMs
    // timeout is what ends the invocation.
  }
});
