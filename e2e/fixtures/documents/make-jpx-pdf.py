"""
Writes jpx-standard-fonts.pdf: one A4 page whose picture is a JPEG 2000
(/JPXDecode) image and whose text is set in Helvetica and Times-Roman, named
but not embedded. pdf.js needs its wasm decoder for the first and its standard
fonts for the second; without them the picture is dropped and the fonts are
substituted. Needs Pillow built with OpenJPEG: python3 make-jpx-pdf.py
"""

import io
import pathlib

from PIL import Image, ImageDraw

WIDTH, HEIGHT = 640, 400

image = Image.new("RGB", (WIDTH, HEIGHT))
draw = ImageDraw.Draw(image)
for y in range(HEIGHT):
    for x in range(0, WIDTH, 4):
        draw.rectangle(
            (x, y, x + 3, y),
            fill=(40 + x * 180 // WIDTH, 90 + y * 120 // HEIGHT, 200 - x * 120 // WIDTH),
        )
for index, x in enumerate(range(40, WIDTH - 40, 80)):
    draw.ellipse((x, 140, x + 60, 200), fill=(255, 255, 255) if index % 2 else (20, 20, 20))
codestream = io.BytesIO()
image.save(codestream, format="JPEG2000", no_jp2=True)
jpx = codestream.getvalue()

content = b"""q
480 0 0 300 57.5 420 cm
/Im1 Do
Q
BT
/F1 24 Tf
57.5 770 Td
(JPEG 2000 picture, standard fonts) Tj
ET
BT
/F2 13 Tf
57.5 380 Td
16 TL
(The picture above is encoded with JPXDecode. This text is Times-Roman) Tj
T*
(and the heading Helvetica, neither embedded in the file.) Tj
ET
"""

objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R"
    b" /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << /Im1 7 0 R >> >> >>",
    b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>",
    b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB"
    b" /BitsPerComponent 8 /Filter /JPXDecode /Length %d >>\nstream\n" % (WIDTH, HEIGHT, len(jpx))
    + jpx
    + b"\nendstream",
]

out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
offsets = []
for number, body in enumerate(objects, start=1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
for offset in offsets:
    out += b"%010d 00000 n \n" % offset
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)

pathlib.Path(__file__).with_name("jpx-standard-fonts.pdf").write_bytes(out)
