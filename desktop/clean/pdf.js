'use strict';

/*
 * PDF metadata cleaning, ported to plain Node (Electron main process) from
 * the old public/js/metadata/pdf-clean.js — same logic, same library
 * (pdf-lib), just running outside the browser:
 *
 * - Clears the Info dictionary (Title, Author, Subject, Keywords, Creator,
 *   Producer, creation/modification dates).
 * - Removes the XMP metadata stream referenced by the catalog.
 * - pdfDoc.save() rewrites the document from scratch, discarding any old
 *   "incremental updates" that could contain earlier versions of the
 *   document with metadata.
 */

const { PDFDocument, PDFName } = require('pdf-lib');

/**
 * @param {Buffer} inputBuffer contents of the .pdf file
 * @returns {Promise<Buffer>} cleaned PDF
 * @throws {Error} if the PDF is invalid, encrypted, or corrupted
 */
async function cleanPdf(inputBuffer) {
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(inputBuffer, {
      updateMetadata: false,
      throwOnInvalidObject: false,
      ignoreEncryption: false,
    });
  } catch (e) {
    throw new Error('Invalid, encrypted, or corrupted PDF — could not clean the metadata.');
  }

  try {
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');
    const epoch = new Date(0);
    pdfDoc.setCreationDate(epoch);
    pdfDoc.setModificationDate(epoch);
    pdfDoc.catalog.delete(PDFName.of('Metadata'));
  } catch (e) {
    throw new Error('Failed to remove the PDF metadata.');
  }

  let outBytes;
  try {
    outBytes = await pdfDoc.save({ useObjectStreams: false });
  } catch (e) {
    throw new Error('Failed to save the cleaned PDF.');
  }
  return Buffer.from(outBytes);
}

module.exports = { cleanPdf };
