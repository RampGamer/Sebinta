'use strict';

/*
 * Office OOXML (.docx/.xlsx/.pptx) metadata cleaning, ported to plain Node
 * (Electron main process, outside any page Worker/CSP). Mirrors the logic
 * already validated in cli/officeclean.go and the old
 * public/js/metadata/office-clean.js: replaces docProps/core.xml and
 * docProps/app.xml with empty versions, removes docProps/custom.xml, the
 * embedded thumbnail, and the entire customXml/ folder (Custom XML Parts —
 * where classification/DLP tools like Titus or Microsoft Purview store
 * tags outside the usual Office properties).
 */

const fflate = require('fflate');

const EMPTY_CORE_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<cp:coreProperties ' +
  'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>';

const EMPTY_APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';

const REMOVED_PART_MATCHERS = [/customXml\//, /docProps\/thumbnail\./, /docProps\/custom\.xml$/];

function stripRelationships(xmlText) {
  return xmlText.replace(/<Relationship\b[^>]*\/>/g, (tag) => {
    const m = /Target="([^"]*)"/.exec(tag);
    if (!m) return tag;
    return REMOVED_PART_MATCHERS.some((re) => re.test(m[1])) ? '' : tag;
  });
}

function stripContentTypeOverrides(xmlText) {
  return xmlText.replace(/<Override\b[^>]*\/>/g, (tag) => {
    const m = /PartName="([^"]*)"/.exec(tag);
    if (!m) return tag;
    return REMOVED_PART_MATCHERS.some((re) => re.test(m[1])) ? '' : tag;
  });
}

/**
 * @param {Buffer} inputBuffer contents of the .docx/.xlsx/.pptx file
 * @returns {{buffer: Buffer, removed: string[]}} cleaned contents and a human-readable list of what was removed
 * @throws {Error} if the file isn't a valid OOXML package
 */
function cleanOoxml(inputBuffer) {
  let zip;
  try {
    zip = fflate.unzipSync(new Uint8Array(inputBuffer));
  } catch (e) {
    throw new Error('Invalid or corrupted Office file — could not clean the metadata.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoder = new TextEncoder();
  const removed = [];
  let touchedAnyPart = false;

  if (zip['docProps/core.xml']) {
    removed.push('Core properties (author, title, creation/edit dates) — docProps/core.xml');
    zip['docProps/core.xml'] = encoder.encode(EMPTY_CORE_XML);
    touchedAnyPart = true;
  }
  if (zip['docProps/app.xml']) {
    removed.push('Application properties (company, manager, editing time) — docProps/app.xml');
    zip['docProps/app.xml'] = encoder.encode(EMPTY_APP_XML);
    touchedAnyPart = true;
  }

  let customXmlCount = 0;
  let hasCustomProps = false;
  let hasThumbnail = false;
  for (const name of Object.keys(zip)) {
    if (name.startsWith('customXml/')) { customXmlCount++; delete zip[name]; touchedAnyPart = true; }
    else if (name === 'docProps/custom.xml') { hasCustomProps = true; delete zip[name]; touchedAnyPart = true; }
    else if (/^docProps\/thumbnail\./.test(name)) { hasThumbnail = true; delete zip[name]; touchedAnyPart = true; }
  }
  if (hasCustomProps) removed.push('Custom properties — docProps/custom.xml');
  if (hasThumbnail) removed.push('Thumbnail embedded in the document');
  if (customXmlCount > 0) removed.push(`Custom XML Parts — classification/DLP tags (${customXmlCount} file(s))`);

  for (const name of Object.keys(zip)) {
    if (!name.endsWith('.rels')) continue;
    const original = decoder.decode(zip[name]);
    const cleaned = stripRelationships(original);
    if (cleaned !== original) zip[name] = encoder.encode(cleaned);
  }
  if (zip['[Content_Types].xml']) {
    const original = decoder.decode(zip['[Content_Types].xml']);
    const cleaned = stripContentTypeOverrides(original);
    if (cleaned !== original) zip['[Content_Types].xml'] = encoder.encode(cleaned);
  }

  if (!touchedAnyPart) {
    throw new Error('This file doesn\'t look like a valid Office OOXML document.');
  }

  let repacked;
  try {
    repacked = fflate.zipSync(zip, { level: 6 });
  } catch (e) {
    throw new Error('Failed to rebuild the document after cleaning the metadata.');
  }
  return { buffer: Buffer.from(repacked), removed };
}

module.exports = { cleanOoxml };
