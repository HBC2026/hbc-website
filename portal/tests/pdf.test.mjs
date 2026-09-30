// Structural test for the image -> PDF builder.  node --experimental-strip-types tests/pdf.test.mjs
import { buildImagePdf } from '../src/lib/pdf.ts';

let failed = 0;
const ok = (c, n) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };

// 1x1 baseline JPEG
const jpeg = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));
const pdf = buildImagePdf(jpeg, 1000, 1500);
const text = Buffer.from(pdf).toString('latin1');

ok(text.startsWith('%PDF-1.4'), 'has PDF header');
ok(text.trimEnd().endsWith('%%EOF'), 'ends with %%EOF');
ok(text.includes('/MediaBox [0 0 595 893]'), 'page is 595 wide and keeps the 2:3 aspect');

const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
ok(text.slice(xrefAt, xrefAt + 4) === 'xref', 'startxref points at the xref table');
const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
ok(entries.length === 5, 'xref lists 5 objects');
ok(entries.every((off, i) => text.slice(off).startsWith(`${i + 1} 0 obj`)), 'every xref offset points at its object');

const streamLen = Number(/\/Length (\d+) >>\nstream\n\xff\xd8/.exec(text)[1]);
ok(streamLen === jpeg.length, 'image /Length equals the JPEG size');
const at = text.indexOf('stream\n\xff\xd8') + 'stream\n'.length;
ok(Buffer.from(pdf).subarray(at, at + jpeg.length).equals(Buffer.from(jpeg)), 'JPEG bytes are embedded unchanged');

process.exit(failed ? 1 : 0);
