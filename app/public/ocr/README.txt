Offline OCR assets (tesseract.js)
=================================

Everything the camera OCR scanner loads at runtime lives in this folder. The
app must work with no network at all (Android WebView, and networks where the
jsdelivr CDN is not reachable), so src/ui/components/OcrScanner.tsx passes
explicit workerPath / corePath / langPath pointing here and never falls back to
the tesseract.js CDN defaults.

Files and where they come from
------------------------------

worker.min.js                     111 KB
    Copied from node_modules/tesseract.js/dist/worker.min.js
    tesseract.js 7.0.0

tesseract-core-simd-lstm.wasm.js  3.9 MB
tesseract-core-lstm.wasm.js       3.9 MB
    Copied from node_modules/tesseract.js-core/
    tesseract.js-core 7.0.0
    Single-file builds: the wasm binary is embedded in the .js, so no extra
    fetch happens. LSTM-only, which is what OEM.LSTM_ONLY needs. The scanner
    probes for wasm SIMD and loads the -simd- build when it is supported,
    otherwise the plain one.

eng.traineddata.gz                1.9 MB (4.1 MB unpacked)
    https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
    downloaded once, then gzip -9. tesseract.js appends ".gz" itself, and
    caches the unpacked data in IndexedDB after the first pass.

Refreshing after a tesseract.js upgrade
---------------------------------------

    cd app
    cp node_modules/tesseract.js/dist/worker.min.js public/ocr/
    cp node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js \
       node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js public/ocr/

The traineddata is independent of the tesseract.js version and does not need
to be refreshed.
