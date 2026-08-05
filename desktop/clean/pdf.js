'use strict';

/*
 * Limpeza de metadados de PDF, portada para Node puro (processo principal
 * do Electron) a partir da antiga public/js/metadata/pdf-clean.js — mesma
 * lógica, mesma biblioteca (pdf-lib), só a correr fora do browser:
 *
 * - Limpa o dicionário Info (Title, Author, Subject, Keywords, Creator,
 *   Producer, datas de criação/modificação).
 * - Remove a stream de metadados XMP referenciada pelo catálogo.
 * - pdfDoc.save() reescreve o documento de raiz, descartando quaisquer
 *   "incremental updates" antigos que pudessem conter versões anteriores
 *   do documento com metadados.
 */

const { PDFDocument, PDFName } = require('pdf-lib');

/**
 * @param {Buffer} inputBuffer conteúdo do ficheiro .pdf
 * @returns {Promise<Buffer>} PDF limpo
 * @throws {Error} se o PDF for inválido, encriptado ou corrompido
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
    throw new Error('PDF inválido, encriptado ou corrompido — não foi possível limpar os metadados.');
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
    throw new Error('Falha ao remover metadados do PDF.');
  }

  let outBytes;
  try {
    outBytes = await pdfDoc.save({ useObjectStreams: false });
  } catch (e) {
    throw new Error('Falha ao gravar o PDF limpo.');
  }
  return Buffer.from(outBytes);
}

module.exports = { cleanPdf };
