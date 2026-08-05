'use strict';

/*
 * Inspetor de metadados — só LEITURA, nunca modifica nada. Serve para
 * diagnóstico: mostrar exatamente que metadados existem num ficheiro,
 * tag a tag, para confirmar (ou desmentir) que a limpeza funcionou.
 *
 * Cobre os formatos onde a limpeza acontece no browser (JPEG/PNG/WebP,
 * PDF, Office OOXML) — ver image-clean.js / pdf-clean.js / office-clean.js
 * para a lógica de limpeza correspondente. Requer window.PDFLib e
 * window.fflate já carregados (script tags normais, não importScripts).
 */

function bytesToAscii(buffer, start, len) {
  const view = new Uint8Array(buffer, start, len);
  let s = '';
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    if (c === 0) break;
    s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '·';
  }
  return s;
}

function formatExifValue(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'number' ? round(v) : v)).join(', ');
  if (typeof value === 'number') return String(round(value));
  return String(value);
}
function round(n) { return Math.round(n * 10000) / 10000; }

// --- Parser EXIF/TIFF mínimo (suficiente para diagnóstico, não para edição) ---
const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const IFD0_TAGS = {
  0x010f: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x013b: 'Artist',
  0x8298: 'Copyright', 0x0132: 'DateTime',
  0x9c9b: 'XPTitle', 0x9c9c: 'XPComment', 0x9c9d: 'XPAuthor', 0x9c9e: 'XPKeywords', 0x9c9f: 'XPSubject',
};
const EXIF_TAGS = {
  0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
  0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa433: 'LensMake', 0xa434: 'LensModel',
};
const GPS_TAGS = {
  0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude', 0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude', 0x0006: 'GPSAltitude',
};

function readRational(view, offset, little) {
  const num = view.getUint32(offset, little);
  const den = view.getUint32(offset + 4, little);
  return den === 0 ? 0 : num / den;
}

function parseIfd(view, buffer, ifdOffset, base, little, tagNames, out, visited) {
  if (visited.has(ifdOffset) || ifdOffset <= 0 || ifdOffset + 2 > view.byteLength) return;
  visited.add(ifdOffset);
  const count = view.getUint16(ifdOffset, little);
  let entryOffset = ifdOffset + 2;
  let exifIfdOffset = 0;
  let gpsIfdOffset = 0;

  for (let i = 0; i < count; i++, entryOffset += 12) {
    if (entryOffset + 12 > view.byteLength) break;
    const tag = view.getUint16(entryOffset, little);
    const type = view.getUint16(entryOffset + 2, little);
    const num = view.getUint32(entryOffset + 4, little);
    const size = (TYPE_SIZES[type] || 1) * num;
    const valueOffset = size <= 4 ? entryOffset + 8 : base + view.getUint32(entryOffset + 8, little);

    if (tag === 0x8769) { exifIfdOffset = base + view.getUint32(entryOffset + 8, little); continue; }
    if (tag === 0x8825) { gpsIfdOffset = base + view.getUint32(entryOffset + 8, little); continue; }

    out.rawCount++;
    const name = tagNames[tag];
    if (!name) continue;

    let value = null;
    try {
      if (type === 2) {
        value = bytesToAscii(buffer, valueOffset, num);
      } else if (type === 5 || type === 10) {
        const values = [];
        for (let k = 0; k < num; k++) values.push(readRational(view, valueOffset + k * 8, little));
        value = values.length === 1 ? values[0] : values;
      } else if (type === 3) {
        value = view.getUint16(valueOffset, little);
      } else if (type === 4 || type === 9) {
        value = view.getUint32(valueOffset, little);
      } else {
        value = `(${num} bytes)`;
      }
    } catch (e) {
      value = '(erro a ler)';
    }
    if (typeof value === 'string' ? value.trim() !== '' : true) {
      out.tags.push({ tag: '0x' + tag.toString(16).toUpperCase().padStart(4, '0'), name, value });
    }
  }
  if (exifIfdOffset) parseIfd(view, buffer, exifIfdOffset, base, little, EXIF_TAGS, out, visited);
  if (gpsIfdOffset) parseIfd(view, buffer, gpsIfdOffset, base, little, GPS_TAGS, out, visited);
}

function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  let dec = dms[0] + dms[1] / 60 + dms[2] / 3600;
  if (ref === 'S' || ref === 'W') dec = -dec;
  return dec;
}

/** @param {ArrayBuffer} buffer @param {number} startOffset início do cabeçalho TIFF ("II"/"MM") */
function parseExifBlock(buffer, startOffset) {
  const view = new DataView(buffer);
  if (startOffset + 8 > buffer.byteLength) return { tags: [], rawCount: 0, error: 'bloco EXIF truncado' };
  const bom = String.fromCharCode(view.getUint8(startOffset)) + String.fromCharCode(view.getUint8(startOffset + 1));
  const little = bom === 'II';
  if (bom !== 'II' && bom !== 'MM') return { tags: [], rawCount: 0, error: 'cabeçalho TIFF inválido' };
  if (view.getUint16(startOffset + 2, little) !== 0x002a) return { tags: [], rawCount: 0, error: 'assinatura TIFF inválida' };
  const ifd0Offset = startOffset + view.getUint32(startOffset + 4, little);
  const out = { tags: [], rawCount: 0 };
  parseIfd(view, buffer, ifd0Offset, startOffset, little, IFD0_TAGS, out, new Set());

  const lat = out.tags.find((t) => t.name === 'GPSLatitude');
  const latRef = out.tags.find((t) => t.name === 'GPSLatitudeRef');
  const lon = out.tags.find((t) => t.name === 'GPSLongitude');
  const lonRef = out.tags.find((t) => t.name === 'GPSLongitudeRef');
  if (lat && lon) {
    const latDec = dmsToDecimal(lat.value, latRef && latRef.value);
    const lonDec = dmsToDecimal(lon.value, lonRef && lonRef.value);
    if (latDec !== null && lonDec !== null) out.gps = { lat: latDec, lon: lonDec };
  }
  return out;
}

function exifFindingsToLines(exif) {
  const lines = exif.tags
    .filter((t) => !t.name.startsWith('GPS'))
    .map((t) => `${t.name}: ${formatExifValue(t.value)}`);
  if (exif.gps) lines.push(`📍 Localização GPS: ${exif.gps.lat.toFixed(6)}, ${exif.gps.lon.toFixed(6)}`);
  return lines;
}

// --- JPEG ---
function scanJpeg(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 4 || view.getUint16(0) !== 0xffd8) {
    return { supported: true, error: 'Não parece ser um JPEG válido (assinatura incorreta).', findings: [] };
  }
  const findings = [];
  let offset = 2;
  while (offset + 4 <= buffer.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xda) break; // Start of Scan: dados de imagem a seguir
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.byteLength) break;
    const dataStart = offset + 4;
    const dataLen = length - 2;

    if (marker === 0xe0) {
      findings.push({ label: 'JFIF (APP0)', severity: 'info', detail: `${dataLen} bytes` });
    } else if (marker === 0xe1) {
      if (bytesToAscii(buffer, dataStart, 4) === 'Exif') {
        const exif = parseExifBlock(buffer, dataStart + 6);
        findings.push({
          label: 'EXIF (APP1)', severity: exif.tags.length ? 'warning' : 'info',
          detail: `${exif.rawCount} tag(s) no total, ${exif.tags.length} reconhecida(s) abaixo`,
          lines: exifFindingsToLines(exif),
        });
      } else if (bytesToAscii(buffer, dataStart, 29).indexOf('adobe.com/xap') !== -1) {
        const xmpText = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer, dataStart, dataLen));
        findings.push({ label: 'XMP (APP1)', severity: 'warning', detail: `${dataLen} bytes`, lines: [xmpText.slice(0, 500) + (xmpText.length > 500 ? '…' : '')] });
      } else {
        findings.push({ label: 'APP1 desconhecido', severity: 'info', detail: `${dataLen} bytes` });
      }
    } else if (marker === 0xe2) {
      findings.push({ label: 'ICC Profile / FlashPix (APP2)', severity: 'info', detail: `${dataLen} bytes — perfil de cor, não é informação pessoal` });
    } else if (marker === 0xed) {
      findings.push({ label: 'Photoshop IRB / IPTC (APP13)', severity: 'warning', detail: `${dataLen} bytes` });
    } else if (marker === 0xee) {
      findings.push({ label: 'Adobe (APP14)', severity: 'info', detail: `${dataLen} bytes` });
    } else if (marker === 0xfe) {
      findings.push({ label: 'Comentário (COM)', severity: 'warning', detail: bytesToAscii(buffer, dataStart, Math.min(dataLen, 300)) });
    }
    offset += 2 + length;
  }
  return { supported: true, findings };
}

// --- PNG ---
function scanPng(buffer) {
  const view = new DataView(buffer);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buffer.byteLength < 8 || view.getUint8(i) !== sig[i]) {
      return { supported: true, error: 'Não parece ser um PNG válido.', findings: [] };
    }
  }
  const findings = [];
  const decoder = new TextDecoder('latin1');
  let offset = 8;
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset);
    const type = bytesToAscii(buffer, offset + 4, 4);
    const dataStart = offset + 8;
    if (dataStart + length + 4 > buffer.byteLength) break;

    if (type === 'tEXt') {
      const raw = new Uint8Array(buffer, dataStart, length);
      const nul = raw.indexOf(0);
      const keyword = decoder.decode(raw.slice(0, nul < 0 ? length : nul));
      const text = nul < 0 ? '' : decoder.decode(raw.slice(nul + 1));
      findings.push({ label: `tEXt: ${keyword}`, severity: 'warning', detail: text.slice(0, 300) });
    } else if (type === 'iTXt') {
      const raw = new Uint8Array(buffer, dataStart, length);
      const nul = raw.indexOf(0);
      const keyword = decoder.decode(raw.slice(0, nul < 0 ? length : nul));
      findings.push({ label: `iTXt: ${keyword}`, severity: 'warning', detail: `${length} bytes (texto internacional)` });
    } else if (type === 'zTXt') {
      const raw = new Uint8Array(buffer, dataStart, length);
      const nul = raw.indexOf(0);
      const keyword = decoder.decode(raw.slice(0, nul < 0 ? length : nul));
      let text = '(comprimido, não foi possível descomprimir)';
      try {
        const inflated = window.fflate.unzlibSync(raw.slice(nul + 2));
        text = new TextDecoder('latin1').decode(inflated).slice(0, 300);
      } catch (e) { /* mantém o placeholder */ }
      findings.push({ label: `zTXt: ${keyword}`, severity: 'warning', detail: text });
    } else if (type === 'eXIf') {
      const exif = parseExifBlock(buffer, dataStart);
      findings.push({
        label: 'eXIf', severity: exif.tags.length ? 'warning' : 'info',
        detail: `${exif.rawCount} tag(s) no total`, lines: exifFindingsToLines(exif),
      });
    } else if (type === 'tIME') {
      const y = view.getUint16(dataStart);
      const mo = view.getUint8(dataStart + 2), d = view.getUint8(dataStart + 3);
      const h = view.getUint8(dataStart + 4), mi = view.getUint8(dataStart + 5), s = view.getUint8(dataStart + 6);
      findings.push({ label: 'tIME (data de modificação)', severity: 'warning', detail: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${h}:${mi}:${s}` });
    }
    offset = dataStart + length + 4;
    if (type === 'IEND') break;
  }
  return { supported: true, findings };
}

// --- WebP ---
function scanWebp(buffer) {
  if (buffer.byteLength < 12 || bytesToAscii(buffer, 0, 4) !== 'RIFF' || bytesToAscii(buffer, 8, 4) !== 'WEBP') {
    return { supported: true, error: 'Não parece ser um WebP válido.', findings: [] };
  }
  const view = new DataView(buffer);
  const findings = [];
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const fourcc = bytesToAscii(buffer, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    if (dataStart + size > buffer.byteLength) break;

    if (fourcc === 'EXIF') {
      let start = dataStart;
      if (bytesToAscii(buffer, dataStart, 4) === 'Exif') start += 6;
      const exif = parseExifBlock(buffer, start);
      findings.push({
        label: 'EXIF', severity: exif.tags.length ? 'warning' : 'info',
        detail: `${exif.rawCount} tag(s) no total`, lines: exifFindingsToLines(exif),
      });
    } else if (fourcc === 'XMP ') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer, dataStart, size));
      findings.push({ label: 'XMP', severity: 'warning', detail: text.slice(0, 500) });
    }
    offset = dataStart + size + (size % 2);
  }
  return { supported: true, findings };
}

// --- PDF ---
async function scanPdf(buffer) {
  if (!window.PDFLib) return { supported: false, findings: [], error: 'pdf-lib não carregado.' };
  const { PDFDocument, PDFName } = window.PDFLib;
  let doc;
  try {
    doc = await PDFDocument.load(buffer, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    return { supported: true, error: 'Não foi possível abrir este PDF (pode estar encriptado ou corrompido).', findings: [] };
  }
  const findings = [];
  // Título/Autor/Assunto/Palavras-chave/Creator/Producer identificam
  // pessoas ou software — sinalizados como aviso. As datas, por si só, não
  // são consideradas dados pessoais sensíveis (e a limpeza deste projeto
  // define-as para a época Unix como valor "apagado", não deixa em branco
  // — ver pdf-clean.js), por isso ficam só como informação.
  const warningGetters = [
    ['Title', () => doc.getTitle()], ['Author', () => doc.getAuthor()], ['Subject', () => doc.getSubject()],
    ['Keywords', () => doc.getKeywords()], ['Creator', () => doc.getCreator()], ['Producer', () => doc.getProducer()],
  ];
  for (const [name, getter] of warningGetters) {
    let value;
    try { value = getter(); } catch (e) { continue; }
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      findings.push({ label: `Info: ${name}`, severity: 'warning', detail: String(value) });
    }
  }
  const dateGetters = [['CreationDate', () => doc.getCreationDate()], ['ModificationDate', () => doc.getModificationDate()]];
  for (const [name, getter] of dateGetters) {
    let value;
    try { value = getter(); } catch (e) { continue; }
    if (value instanceof Date && !isNaN(value)) {
      const isCleared = value.getTime() === 0; // 1 Jan 1970 = valor definido pela limpeza, não é a data original
      findings.push({ label: `Info: ${name}`, severity: 'info', detail: isCleared ? `${value.toISOString()} (removida pela limpeza)` : value.toString() });
    }
  }
  let hasXmp = false;
  try { hasXmp = doc.catalog.has(PDFName.of('Metadata')); } catch (e) { /* ignora */ }
  if (hasXmp) findings.push({ label: 'Stream de metadados XMP no catálogo', severity: 'warning', detail: 'presente' });
  try { findings.push({ label: 'Número de páginas', severity: 'info', detail: String(doc.getPageCount()) }); } catch (e) { /* ignora */ }
  return { supported: true, findings };
}

// --- Office OOXML ---

/** Verifica se um XML de propriedades tem algum valor entre as tags, ou está vazio (limpo). */
function xmlHasContent(xml) {
  const withoutDecl = xml.replace(/<\?xml[^>]*\?>/, '').trim();
  const innerMatch = withoutDecl.match(/^<[^>]+>([\s\S]*)<\/[^>]+>$/);
  const inner = innerMatch ? innerMatch[1].trim() : withoutDecl;
  return inner.length > 0;
}

function scanOoxml(buffer) {
  if (!window.fflate) return { supported: false, findings: [], error: 'fflate não carregado.' };
  let zip;
  try {
    zip = window.fflate.unzipSync(new Uint8Array(buffer));
  } catch (e) {
    return { supported: true, error: 'Não foi possível abrir este ficheiro como ZIP/Office.', findings: [] };
  }
  const findings = [];
  const decoder = new TextDecoder('utf-8', { fatal: false });

  for (const part of ['docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml']) {
    if (!zip[part]) continue;
    const xml = decoder.decode(zip[part]);
    const hasContent = xmlHasContent(xml);
    findings.push({
      label: part,
      severity: hasContent ? 'warning' : 'info',
      detail: hasContent ? xml.slice(0, 600) : '(presente, mas vazio — sem valores preenchidos)',
    });
  }
  const thumb = Object.keys(zip).find((k) => /^docProps\/thumbnail\./.test(k));
  if (thumb) findings.push({ label: thumb, severity: 'warning', detail: 'thumbnail incorporada no documento' });

  // Custom XML Parts (customXml/) — usadas por ferramentas de
  // classificação/DLP empresariais (Titus, Microsoft Purview Information
  // Protection, Boldon James, etc.) para guardar etiquetas fora das
  // propriedades habituais do Office, ex.: TitusGUID, CLASSIFICATION.
  const customXmlParts = Object.keys(zip).filter((k) => k.startsWith('customXml/') && k.endsWith('.xml'));
  for (const part of customXmlParts) {
    let xml;
    try { xml = decoder.decode(zip[part]); } catch (e) { continue; }
    findings.push({ label: `${part} (Custom XML Part)`, severity: 'warning', detail: xml.slice(0, 600) });
  }

  return { supported: true, findings };
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} ext extensão em minúsculas, com ponto (ex.: ".jpg")
 * @returns {Promise<{supported:boolean, findings:Array, error?:string}>}
 */
async function inspectFile(buffer, ext) {
  const e = (ext || '').toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return scanJpeg(buffer);
  if (e === '.png') return scanPng(buffer);
  if (e === '.webp') return scanWebp(buffer);
  if (e === '.pdf') return scanPdf(buffer);
  if (e === '.docx' || e === '.xlsx' || e === '.pptx') return scanOoxml(buffer);
  return { supported: false, findings: [] };
}

window.MetadataInspect = { inspectFile };
