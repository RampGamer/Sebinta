'use strict';

/*
 * Limpeza de metadados de PDF no browser, usando pdf-lib (carregada via
 * importScripts em worker.js, expõe o global PDFLib).
 *
 * - Limpa o dicionário Info (Title, Author, Subject, Keywords, Creator,
 *   Producer, datas de criação/modificação).
 * - Remove a stream de metadados XMP referenciada pelo catálogo
 *   (catalog.delete(PDFName.of('Metadata'))).
 * - Ao gravar com pdfDoc.save(), o documento é reescrito de raiz, o que
 *   também descarta quaisquer "incremental updates" antigos que pudessem
 *   conter versões anteriores do documento com metadados.
 */
self.cleanPdf = async function cleanPdf(buffer) {
  const { PDFDocument, PDFName } = self.PDFLib;

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(buffer, {
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

  const outBuffer = outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength);
  return { buffer: outBuffer, mimeType: 'application/pdf' };
};
