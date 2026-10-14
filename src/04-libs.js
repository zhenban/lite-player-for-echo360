// ===================================================================================
// The library files loaded when first needed, by npm path, with their SHA-256 (hex).
// platform.libBlobUrl / importLib refuse a file whose bytes differ, so a changed file on
// the CDN is never run; Tesseract's language data is checked in its Worker
// (tessWorkerGuard, 66-slide-ocr.js). hls.js comes through @require instead (meta.txt).
//
// Each hash was taken from the CDN and matched against the package on registry.npmjs.org.
// `npm run check-requires` checks them against the CDN again (CI). A new version of a
// library means new paths and new hashes here.
// ===================================================================================

const LIB_SHA256 = {
  'pdfjs-dist@6.4.299/build/pdf.min.mjs': '57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2',
  'pdfjs-dist@6.4.299/build/pdf.worker.min.mjs': '9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18',
  'tesseract.js@7.0.0/dist/tesseract.esm.min.js': '64871d76c75609fd5413b88a8171e2ef40deedd77d5875ba23df104b2d05eb29',
  'tesseract.js@7.0.0/dist/worker.min.js': '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
  'tesseract.js-core@7.0.0/tesseract-core-lstm.wasm.js': 'eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680',
  'tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js': 'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38',
  '@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz': '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  '@tesseract.js-data/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz': 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c',
  '@tesseract.js-data/chi_tra@1.0.0/4.0.0_best_int/chi_tra.traineddata.gz': '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743',
  '@tesseract.js-data/jpn@1.0.0/4.0.0_best_int/jpn.traineddata.gz': '2b63ebfbf1484de4a08ce53b29ef98a1c17658a93cbd38acb665d7d316d0be88',
  '@tesseract.js-data/kor@1.0.0/4.0.0_best_int/kor.traineddata.gz': '78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126',
  '@tesseract.js-data/rus@1.0.0/4.0.0_best_int/rus.traineddata.gz': 'f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a',
  '@tesseract.js-data/ell@1.0.0/4.0.0_best_int/ell.traineddata.gz': 'e8a293abb398ec479176c1575aef24e2bacb0611c713f3fa996f97f0cd996fb3',
  '@tesseract.js-data/ara@1.0.0/4.0.0_best_int/ara.traineddata.gz': 'f4746c44b02342dd5b3d4f0198000f47d7c49f1a229e63e0f436c0592dcd9639',
  '@tesseract.js-data/heb@1.0.0/4.0.0_best_int/heb.traineddata.gz': '9c70b524200dae77fb25e3567566eee600ccbcae9aeb89722990ccae0e84e805',
  '@tesseract.js-data/tha@1.0.0/4.0.0_best_int/tha.traineddata.gz': '4550a5505184d1b79cf10416d5b19e643001d95411d5e717954dd26feef3ae74',
  '@tesseract.js-data/hin@1.0.0/4.0.0_best_int/hin.traineddata.gz': 'f3b6a0d320df38d886178cdd727b90dbf9df3db053adb32bd9cf73f0463cda07',
};
