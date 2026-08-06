'use strict';

/*
 * Fast detection of classification/DLP tags in an Office OOXML document,
 * without decompressing anything (just lists the ZIP entry names) — used
 * to decide whether cleanup should be forced even with the user's toggle
 * off. See desktop/clean/office.js for the actual cleaning.
 */

const fflate = require('fflate');

/**
 * @param {Buffer} inputBuffer contents of the .docx/.xlsx/.pptx file
 * @returns {boolean} true if the package contains the customXml/ folder (Titus/Purview/etc.)
 */
function hasDlpTags(inputBuffer) {
  let found = false;
  try {
    fflate.unzipSync(new Uint8Array(inputBuffer), {
      filter(file) {
        if (file.name.startsWith('customXml/')) found = true;
        return false; // never decompresses — we only need the names
      },
    });
  } catch (e) {
    return false; // invalid file: let cleanOoxml() report the real error
  }
  return found;
}

module.exports = { hasDlpTags };
