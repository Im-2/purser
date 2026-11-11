// After `vite build`: write .br and .gz next to every text asset in dist, so the server can send them pre-compressed
// (@fastify/static preCompressed). Uses Node's built-in zlib; no dependency.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TEXT = /\.(js|mjs|css|html|svg|json|txt|webmanifest)$/;
let files = 0;
let raw = 0;
let br = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (TEXT.test(name) && statSync(p).size > 1024) {
      const buf = readFileSync(p);
      const b = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      writeFileSync(p + ".br", b);
      writeFileSync(p + ".gz", gzipSync(buf, { level: 9 }));
      files++;
      raw += buf.length;
      br += b.length;
    }
  }
};
walk(dist);
console.log(`precompress: ${files} files, ${(raw / 1024).toFixed(0)} KiB -> ${(br / 1024).toFixed(0)} KiB brotli`);
