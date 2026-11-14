/* Field Measure — a very small PDF maker.
 *
 * Just enough PDF for the job package: pages of text and JPEG pictures.
 * Written here rather than pulled from a library so it works with no signal
 * and adds nothing to download. JPEGs go in as they are (PDF can hold a JPEG
 * byte for byte), so a photo is no bigger inside the PDF than outside it.
 *
 *   var d = FMPdf();            // US Letter, 612 x 792 points
 *   d.page();
 *   d.text(36, 50, 'Hello', 12, 'bold');      // x, y from the TOP left
 *   d.image(bytes, pxW, pxH, 36, 80, 540, 300);
 *   var blob = d.blob();
 *
 * Fonts are the three every PDF reader has built in: Helvetica, Helvetica
 * Bold and Courier (fixed width, which keeps the summary's columns lined up).
 */
(function () {
  'use strict';

  var W = 612, H = 792;
  var FONTS = { regular: 'F1', bold: 'F2', mono: 'F3' };

  /* The built-in fonts use the Windows-1252 character set. The summary's
     dashes, dots and quotes are all in it; anything that isn't becomes '?'. */
  var CP = { 0x2014: 0x97, 0x2013: 0x96, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94,
             0x2022: 0x95, 0x2026: 0x85, 0x20AC: 0x80, 0x2122: 0x99 };
  var SWAP = { 0x2713: 'ok', 0x203A: '>', 0x2039: '<', 0x2192: '->', 0x21BA: '', 0x21BB: '' };
  function winAnsi(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (SWAP[c] !== undefined) { out += SWAP[c]; continue; }
      if (CP[c]) { out += String.fromCharCode(CP[c]); continue; }
      if (c < 32) continue;
      out += (c < 256) ? s[i] : '?';
    }
    return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  function bytes(str) {                 // a string of 0-255 char codes -> bytes
    var b = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 255;
    return b;
  }
  function n(v) { return (Math.round(v * 100) / 100).toString(); }

  window.FMPdf = function () {
    var pages = [];     // each: array of content-stream lines
    var images = [];    // {data: Uint8Array, w, h}
    var cur = null;

    return {
      W: W, H: H,
      page: function () { cur = []; pages.push(cur); return this; },

      /* Courier is 0.6 em wide per character; Helvetica averages ~0.5. Used
         for wrapping and centring, so near enough is fine. */
      width: function (s, size, font) { return s.length * size * (font === 'mono' ? 0.6 : 0.52); },

      text: function (x, y, s, size, font, grey) {
        if (!cur) this.page();
        cur.push('BT ' + (grey ? '0.4 0.43 0.46 rg ' : '0 0 0 rg ') + '/' + (FONTS[font] || 'F1') + ' ' + n(size) +
          ' Tf ' + n(x) + ' ' + n(H - y - size) + ' Td (' + winAnsi(String(s)) + ') Tj ET');
        return this;
      },

      line: function (x1, y1, x2, y2, grey) {
        if (!cur) this.page();
        cur.push((grey ? '0.8 0.82 0.84' : '0 0 0') + ' RG 0.75 w ' + n(x1) + ' ' + n(H - y1) + ' m ' +
          n(x2) + ' ' + n(H - y2) + ' l S');
        return this;
      },

      /* data: the JPEG's bytes. pw/ph: its size in pixels. Placed at x,y
         (top left) and drawn dw x dh points. */
      image: function (data, pw, ph, x, y, dw, dh) {
        if (!cur) this.page();
        images.push({ data: data, w: pw, h: ph });
        var name = 'Im' + images.length;
        cur.push('q ' + n(dw) + ' 0 0 ' + n(dh) + ' ' + n(x) + ' ' + n(H - y - dh) + ' cm /' + name + ' Do Q');
        cur.push('% uses ' + name);
        return this;
      },

      blob: function () {
        var parts = [], offsets = [], pos = 0;
        function put(p) { var b = (typeof p === 'string') ? bytes(p) : p; parts.push(b); pos += b.length; }
        function obj(num, body) { offsets[num] = pos; put(num + ' 0 obj\n'); body(); put('\nendobj\n'); }

        /* numbering: 1 catalog, 2 page tree, 3-5 fonts, then images, then
           a page and its content stream for each page */
        var imgBase = 6, pageBase = imgBase + images.length;
        var kids = [];
        for (var p = 0; p < pages.length; p++) kids.push((pageBase + p * 2) + ' 0 R');

        put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
        obj(1, function () { put('<< /Type /Catalog /Pages 2 0 R >>'); });
        obj(2, function () { put('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>'); });
        ['Helvetica', 'Helvetica-Bold', 'Courier'].forEach(function (f, i) {
          obj(3 + i, function () {
            put('<< /Type /Font /Subtype /Type1 /BaseFont /' + f + ' /Encoding /WinAnsiEncoding >>');
          });
        });
        images.forEach(function (im, i) {
          obj(imgBase + i, function () {
            put('<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h +
              ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.data.length +
              ' >>\nstream\n');
            put(im.data);
            put('\nendstream');
          });
        });
        pages.forEach(function (lines, pi) {
          var used = [];
          lines.forEach(function (l) { var m = /^% uses Im(\d+)$/.exec(l); if (m) used.push(+m[1]); });
          var xo = used.map(function (k) { return '/Im' + k + ' ' + (imgBase + k - 1) + ' 0 R'; }).join(' ');
          var stream = bytes(lines.filter(function (l) { return l.charAt(0) !== '%'; }).join('\n'));
          obj(pageBase + pi * 2, function () {
            put('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Contents ' +
              (pageBase + pi * 2 + 1) + ' 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>' +
              (xo ? ' /XObject << ' + xo + ' >>' : '') + ' >> >>');
          });
          obj(pageBase + pi * 2 + 1, function () {
            put('<< /Length ' + stream.length + ' >>\nstream\n');
            put(stream);
            put('\nendstream');
          });
        });
        var count = pageBase + pages.length * 2;
        var xref = pos;
        var tbl = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
        for (var k = 1; k < count; k++) tbl += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n';
        put(tbl);
        put('trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
        return new Blob(parts, { type: 'application/pdf' });
      }
    };
  };
})();
