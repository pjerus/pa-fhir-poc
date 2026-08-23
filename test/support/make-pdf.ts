/**
 * Minimal deterministic PDF writer for test fixtures — Helvetica text lines,
 * one content stream per page, byte-accurate xref. No dependencies, so
 * fixtures are regenerable without adding a PDF-authoring library.
 */
export function makePdf(pages: ReadonlyArray<readonly string[]>): Uint8Array {
  const escape = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const objects: string[] = [];
  const pageObjNumber = (pageIndex: number): number => 4 + pageIndex * 2;
  const kids = pages.map((_, i) => `${pageObjNumber(i)} 0 R`).join(' ');

  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`;
  objects[3] = `3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  pages.forEach((lines, i) => {
    const pageNum = pageObjNumber(i);
    const contentNum = pageNum + 1;
    const ops = lines
      .map((line, j) =>
        j === 0 ? `BT /F1 12 Tf 72 720 Td (${escape(line)}) Tj` : `0 -16 Td (${escape(line)}) Tj`,
      )
      .join('\n');
    const stream = `${ops}\nET`;
    objects[pageNum] =
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`;
    objects[contentNum] =
      `${contentNum} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\n` +
      `stream\n${stream}\nendstream\nendobj\n`;
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(body, 'utf8');
    body += objects[n];
  }
  const xrefStart = Buffer.byteLength(body, 'utf8');
  const count = objects.length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body + xref + trailer, 'utf8'));
}
