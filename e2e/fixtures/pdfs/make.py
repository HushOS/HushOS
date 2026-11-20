"""
The PDF tools fixtures of docs/file-tools-design.md, feature (c): small PDFs written byte by byte
here, never through a PDF library that would repair or normalise them. The web's engine
(@cantoo/pdf-lib, apps/web/src/lib/pdf-tools/structure.ts) and the core's (lopdf,
crates/hushos-core/src/tools/pdf_tools.rs) are both held to expected.json: the same page count,
order, sizes and /Rotate, the same refusal, the same warnings, for every file and every
operation listed there.

What each file and each operation must give is worked out here from what this script wrote (the
page sizes and rotations it chose, the pages an operation names), not by either engine.

Every page draws its own number and a canary string. The canary lets the end-to-end tests check
that no plaintext of a source reaches storage; the Info dictionary's canary lets every test check
that no output carries the source's document information (an output has no Info at all).

    python3 -I e2e/fixtures/pdfs/make.py

Deterministic: running it again rewrites the same bytes.
"""

import hashlib
import json
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))

CANARY = "HUSHOS-CANARY-PDF-5b1e"
INFO_CANARY = "HUSHOS-CANARY-INFO-c37a"
# A fixed file identifier: the encrypted fixture's key is derived from it.
FILE_ID = bytes.fromhex("8f1c2a7d4b5e6f708192a3b4c5d6e7f8")

LETTER = (612, 792)
A4 = (595, 842)
SMALL = (400, 600)
WIDE = (720, 405)

# Fill colours per page number, so a rendered page says which page it is.
COLOURS = [(0.85, 0.1, 0.1), (0.1, 0.6, 0.2), (0.1, 0.2, 0.85), (0.9, 0.7, 0.1), (0.5, 0.1, 0.6)]


def content(number, size):
    r, g, b = COLOURS[(number - 1) % len(COLOURS)]
    w, h = size
    return (
        f"{r} {g} {b} rg 36 36 {w - 72} {h / 3:.0f} re f\n"
        f"0 0 0 rg BT /F1 24 Tf 48 {h - 96} Td (Page {number}) Tj ET\n"
        f"BT /F1 9 Tf 48 {h - 120} Td ({CANARY}) Tj ET\n"
    ).encode()


def stream(dictionary, data):
    return b"<< " + dictionary + b" /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream"


class Pdf:
    """Objects by number, written in order with a classic cross-reference table."""

    def __init__(self, version="1.7"):
        self.version = version
        self.objects = {}

    def add(self, number, body):
        self.objects[number] = body if isinstance(body, bytes) else body.encode()

    def body(self):
        out = bytearray(f"%PDF-{self.version}\n%\xe2\xe3\xcf\xd3\n".encode("latin-1"))
        offsets = {}
        for number in sorted(self.objects):
            offsets[number] = len(out)
            out += f"{number} 0 obj\n".encode() + self.objects[number] + b"\nendobj\n"
        return out, offsets

    def write(self, trailer):
        out, offsets = self.body()
        size = max(self.objects) + 1
        xref = len(out)
        out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
        for number in range(1, size):
            if number in offsets:
                out += f"{offsets[number]:010} 00000 n \n".encode()
            else:
                out += b"0000000000 65535 f \n"
        out += f"trailer\n<< /Size {size} {trailer} >>\nstartxref\n{xref}\n%%EOF\n".encode()
        return bytes(out)


FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
INFO = f"<< /Title ({INFO_CANARY}) /Producer (HushOS fixtures) /CreationDate (D:20260101000000Z) >>"


def simple(pages, *, page_extra=None, catalog_extra="", tree_extra="", first=10):
    """Catalog 1, page tree 2, font 3, info 4; each page and its content from `first` on."""
    pdf = Pdf()
    kids = []
    number = first
    for index, size in enumerate(pages):
        page, data = number, number + 1
        number += 2
        kids.append(page)
        extra = (page_extra or {}).get(index, "")
        pdf.add(
            page,
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {size[0]} {size[1]}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {data} 0 R{extra} >>",
        )
        pdf.add(data, stream(b"", content(index + 1, size)))
    pdf.add(1, f"<< /Type /Catalog /Pages 2 0 R{catalog_extra} >>")
    pdf.add(2, f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)}{tree_extra} >>")
    pdf.add(3, FONT)
    pdf.add(4, INFO)
    return pdf, number


def page_entry(size, rotate=0):
    return {"width": size[0], "height": size[1], "rotate": rotate}


# ---------------------------------------------------------------------------------------------
# The files
# ---------------------------------------------------------------------------------------------


def plain():
    sizes = [LETTER, A4, SMALL]
    pdf, _ = simple(sizes)
    return pdf.write("/Root 1 0 R /Info 4 0 R"), [page_entry(s) for s in sizes]


def rotated():
    """Page 1 inherits /Rotate 180 from the page tree; page 2 sets its own 90 (over the tree's)."""
    sizes = [LETTER, WIDE]
    pdf, _ = simple(sizes, page_extra={1: " /Rotate 90"}, tree_extra=" /Rotate 180")
    return pdf.write("/Root 1 0 R /Info 4 0 R"), [page_entry(LETTER, 180), page_entry(WIDE, 90)]


def nested():
    """A page tree two levels deep, the MediaBox and Resources inherited from the middle node."""
    pdf = Pdf()
    pdf.add(1, "<< /Type /Catalog /Pages 2 0 R >>")
    pdf.add(2, "<< /Type /Pages /Kids [5 0 R 12 0 R] /Count 3 >>")
    pdf.add(3, FONT)
    pdf.add(4, INFO)
    pdf.add(
        5,
        f"<< /Type /Pages /Parent 2 0 R /Kids [10 0 R 14 0 R] /Count 2 /MediaBox [0 0 {A4[0]} {A4[1]}] "
        "/Resources << /Font << /F1 3 0 R >> >> /Rotate 270 >>",
    )
    pdf.add(10, "<< /Type /Page /Parent 5 0 R /Contents 11 0 R >>")
    pdf.add(11, stream(b"", content(1, A4)))
    pdf.add(14, "<< /Type /Page /Parent 5 0 R /Contents 15 0 R /Rotate -90 >>")
    pdf.add(15, stream(b"", content(2, A4)))
    pdf.add(
        12,
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {SMALL[0]} {SMALL[1]}] "
        "/Resources << /Font << /F1 3 0 R >> >> /Contents 13 0 R >>",
    )
    pdf.add(13, stream(b"", content(3, SMALL)))
    # -90 is 270, read the same by every engine.
    return pdf.write("/Root 1 0 R /Info 4 0 R"), [page_entry(A4, 270), page_entry(A4, 270), page_entry(SMALL)]


def signed():
    """A signature field whose value has a /ByteRange: a warning, never a refusal."""
    sizes = [LETTER]
    pdf, n = simple(
        sizes,
        page_extra={0: f" /Annots [{30} 0 R]"},
        catalog_extra=" /AcroForm << /Fields [30 0 R] /SigFlags 3 >>",
    )
    pdf.add(
        30,
        "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 10 0 R /V 31 0 R >>",
    )
    pdf.add(
        31,
        "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached "
        "/ByteRange [0 1024 2048 512] /Contents <" + "00" * 64 + "> /M (D:20260101000000Z) >>",
    )
    return pdf.write("/Root 1 0 R /Info 4 0 R"), [page_entry(s) for s in sizes]


def unsigned_field():
    """An empty signature field (no value, so no /ByteRange): a form, not a signature."""
    sizes = [LETTER]
    pdf, _ = simple(sizes, catalog_extra=" /AcroForm << /Fields [30 0 R] >>")
    pdf.add(30, "<< /FT /Sig /T (Sign here) /Kids [31 0 R] >>")
    # The kid inherits /FT /Sig from its parent and has a value, but the value has no /ByteRange.
    pdf.add(31, "<< /Type /Annot /Subtype /Widget /Parent 30 0 R /Rect [0 0 0 0] /V << /Type /Sig >> >>")
    return pdf.write("/Root 1 0 R /Info 4 0 R"), [page_entry(s) for s in sizes]


def outline_form():
    """Bookmarks and a text field."""
    sizes = [LETTER, LETTER]
    pdf, _ = simple(
        sizes,
        page_extra={0: " /Annots [40 0 R]"},
        catalog_extra=" /Outlines 30 0 R /AcroForm << /Fields [40 0 R] >>",
    )
    pdf.add(30, "<< /Type /Outlines /First 31 0 R /Last 32 0 R /Count 2 >>")
    pdf.add(31, "<< /Title (One) /Parent 30 0 R /Next 32 0 R /Dest [10 0 R /Fit] >>")
    pdf.add(32, "<< /Title (Two) /Parent 30 0 R /Prev 31 0 R /Dest [12 0 R /Fit] >>")
    pdf.add(
        40,
        "<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /V (Ada) /Rect [72 72 300 96] /P 10 0 R >>",
    )
    return pdf.write("/Root 1 0 R /Info 4 0 R"), [page_entry(s) for s in sizes]


# --- Encryption (the standard security handler, revision 3, RC4 128-bit, empty user password) --

PAD = bytes.fromhex("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a")


def rc4(key, data):
    s = list(range(256))
    j = 0
    for i in range(256):
        j = (j + s[i] + key[i % len(key)]) % 256
        s[i], s[j] = s[j], s[i]
    out = bytearray()
    i = j = 0
    for byte in data:
        i = (i + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        out.append(byte ^ s[(s[i] + s[j]) % 256])
    return bytes(out)


def padded(password):
    return (password + PAD)[:32]


def owner_value(owner, user):
    key = hashlib.md5(padded(owner)).digest()
    for _ in range(50):
        key = hashlib.md5(key).digest()
    value = rc4(key, padded(user))
    for i in range(1, 20):
        value = rc4(bytes(b ^ i for b in key), value)
    return value


def file_key(user, o, p):
    digest = hashlib.md5(padded(user) + o + struct.pack("<i", p) + FILE_ID).digest()
    for _ in range(50):
        digest = hashlib.md5(digest).digest()
    return digest


def user_value(key):
    value = rc4(key, hashlib.md5(PAD + FILE_ID).digest())
    for i in range(1, 20):
        value = rc4(bytes(b ^ i for b in key), value)
    return value + bytes(16)


def object_key(key, number):
    return hashlib.md5(key + struct.pack("<I", number)[:3] + b"\x00\x00").digest()[:16]


def encrypted():
    sizes = [LETTER, A4]
    p = -3904  # print and copy refused: the kind of PDF people meet
    o = owner_value(b"owner-secret", b"")
    key = file_key(b"", o, p)
    pdf = Pdf()
    pdf.add(1, "<< /Type /Catalog /Pages 2 0 R >>")
    pdf.add(2, "<< /Type /Pages /Kids [10 0 R 12 0 R] /Count 2 >>")
    pdf.add(3, FONT)
    for index, (page, size) in enumerate(zip((10, 12), sizes)):
        pdf.add(
            page,
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {size[0]} {size[1]}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {page + 1} 0 R >>",
        )
        pdf.add(page + 1, stream(b"", rc4(object_key(key, page + 1), content(index + 1, size))))
    pdf.add(
        20,
        f"<< /Filter /Standard /V 2 /R 3 /Length 128 /P {p} /O <{o.hex()}> /U <{user_value(key).hex()}> >>",
    )
    trailer = f"/Root 1 0 R /Encrypt 20 0 R /ID [<{FILE_ID.hex()}> <{FILE_ID.hex()}>]"
    return pdf.write(trailer), [page_entry(s) for s in sizes]


def object_streams():
    """PDF 1.5: every dictionary in one object stream, a cross-reference stream, no table."""
    sizes = [A4, LETTER, WIDE]
    loose = {}  # objects outside the stream: the content streams
    packed = {}  # objects inside it
    packed[1] = "<< /Type /Catalog /Pages 2 0 R >>"
    packed[2] = "<< /Type /Pages /Kids [10 0 R 12 0 R 14 0 R] /Count 3 >>"
    packed[3] = FONT
    packed[4] = INFO
    for index, size in enumerate(sizes):
        page = 10 + index * 2
        packed[page] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {size[0]} {size[1]}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {page + 1} 0 R"
            + (" /Rotate 90" if index == 2 else "")
            + " >>"
        )
        loose[page + 1] = stream(b"", content(index + 1, size))
    objstm_number = 20
    xref_number = 21
    header = []
    body = bytearray()
    for number in sorted(packed):
        header.append(f"{number} {len(body)}")
        body += packed[number].encode() + b"\n"
    head = (" ".join(header) + "\n").encode()
    data = zlib.compress(head + bytes(body), 9)
    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for number in sorted(loose):
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode() + loose[number] + b"\nendobj\n"
    offsets[objstm_number] = len(out)
    out += f"{objstm_number} 0 obj\n".encode()
    out += stream(f"/Type /ObjStm /N {len(packed)} /First {len(head)} /Filter /FlateDecode".encode(), data)
    out += b"\nendobj\n"
    size = xref_number + 1
    rows = bytearray()
    index_in_stream = {number: i for i, number in enumerate(sorted(packed))}
    xref_offset = len(out)
    for number in range(size):
        if number == 0:
            rows += struct.pack(">BIH", 0, 0, 65535)
        elif number in packed:
            rows += struct.pack(">BIH", 2, objstm_number, index_in_stream[number])
        elif number in offsets:
            rows += struct.pack(">BIH", 1, offsets[number], 0)
        elif number == xref_number:
            rows += struct.pack(">BIH", 1, xref_offset, 0)
        else:
            rows += struct.pack(">BIH", 0, 0, 0)
    out += f"{xref_number} 0 obj\n".encode()
    out += stream(
        f"/Type /XRef /Size {size} /W [1 4 2] /Root 1 0 R /Info 4 0 R /Filter /FlateDecode".encode(),
        zlib.compress(bytes(rows), 9),
    )
    out += f"\nendobj\nstartxref\n{xref_offset}\n%%EOF\n".encode()
    return bytes(out), [page_entry(A4), page_entry(LETTER), page_entry(WIDE, 90)]


def incremental():
    """Two pages, then an update appended after %%EOF: page 1 turned to 270 and a third page added."""
    sizes = [LETTER, A4]
    pdf, _ = simple(sizes)
    base = pdf.write("/Root 1 0 R /Info 4 0 R")
    prev = int(base.rsplit(b"startxref\n", 1)[1].split(b"\n")[0])
    out = bytearray(base)
    updates = {
        10: f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {LETTER[0]} {LETTER[1]}] "
        "/Resources << /Font << /F1 3 0 R >> >> /Contents 11 0 R /Rotate 270 >>",
        2: "<< /Type /Pages /Kids [10 0 R 12 0 R 14 0 R] /Count 3 >>",
        14: f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {SMALL[0]} {SMALL[1]}] "
        "/Resources << /Font << /F1 3 0 R >> >> /Contents 15 0 R >>",
        15: stream(b"", content(3, SMALL)).decode("latin-1"),
    }
    offsets = {}
    for number in sorted(updates):
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode() + updates[number].encode("latin-1") + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 1\n0000000000 65535 f \n"
    for number in sorted(offsets):
        out += f"{number} 1\n{offsets[number]:010} 00000 n \n".encode()
    out += f"trailer\n<< /Size 16 /Root 1 0 R /Info 4 0 R /Prev {prev} >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out), [page_entry(LETTER, 270), page_entry(A4), page_entry(SMALL)]


def damaged():
    """Cut off inside the first page's content: no catalog, no page tree, nothing to recover."""
    data, _ = plain()
    cut = data.index(b"stream\n") + 40
    return data[:cut], None


def truncated_tail():
    """The cross-reference table and trailer lost: every object is still there to be found."""
    data, pages = plain()
    return data[: data.rindex(b"xref\n")], pages


def tree_cycle():
    """The page tree points back at itself: refused, never walked forever."""
    pdf = Pdf()
    pdf.add(1, "<< /Type /Catalog /Pages 2 0 R >>")
    pdf.add(2, "<< /Type /Pages /Kids [5 0 R] /Count 1 >>")
    pdf.add(3, FONT)
    pdf.add(5, "<< /Type /Pages /Parent 2 0 R /Kids [10 0 R 2 0 R] /Count 1 >>")
    pdf.add(
        10,
        f"<< /Type /Page /Parent 5 0 R /MediaBox [0 0 {LETTER[0]} {LETTER[1]}] "
        "/Resources << /Font << /F1 3 0 R >> >> /Contents 11 0 R >>",
    )
    pdf.add(11, stream(b"", content(1, LETTER)))
    return pdf.write("/Root 1 0 R"), None


def reference_cycle():
    """Resources that reach themselves through references, and a /Parent loop above the page:
    copying the page must stop at objects already copied, and inheritance at nodes already seen."""
    pdf = Pdf()
    pdf.add(1, "<< /Type /Catalog /Pages 2 0 R >>")
    pdf.add(2, f"<< /Type /Pages /Kids [10 0 R] /Count 1 /Parent 6 0 R /MediaBox [0 0 {A4[0]} {A4[1]}] >>")
    pdf.add(6, "<< /Type /Pages /Parent 2 0 R /Kids [] /Count 0 >>")
    pdf.add(3, FONT)
    pdf.add(7, "<< /Font << /F1 3 0 R >> /Hush 8 0 R >>")
    pdf.add(8, "<< /Back 7 0 R /Self 8 0 R >>")
    pdf.add(10, "<< /Type /Page /Parent 2 0 R /Resources 7 0 R /Contents 11 0 R >>")
    pdf.add(11, stream(b"", content(1, A4)))
    return pdf.write("/Root 1 0 R"), [page_entry(A4)]


def deep_tree():
    """300 page tree nodes, one inside the next: past the walk's depth bound of 256."""
    pdf = Pdf()
    depth = 300
    pdf.add(1, "<< /Type /Catalog /Pages 100 0 R >>")
    pdf.add(3, FONT)
    for level in range(depth):
        number = 100 + level
        child = number + 1 if level < depth - 1 else 10
        parent = f" /Parent {number - 1} 0 R" if level else ""
        pdf.add(number, f"<< /Type /Pages{parent} /Kids [{child} 0 R] /Count 1 >>")
    pdf.add(
        10,
        f"<< /Type /Page /Parent {100 + depth - 1} 0 R /MediaBox [0 0 {LETTER[0]} {LETTER[1]}] "
        "/Resources << /Font << /F1 3 0 R >> >> /Contents 11 0 R >>",
    )
    pdf.add(11, stream(b"", content(1, LETTER)))
    return pdf.write("/Root 1 0 R"), None


def deep_array():
    """The only page's dictionary holds arrays nested 50,000 deep: no parser may recurse into it."""
    pdf = Pdf()
    pdf.add(1, "<< /Type /Catalog /Pages 2 0 R >>")
    pdf.add(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>")
    pdf.add(3, FONT)
    deep = "[" * 50_000 + "]" * 50_000
    pdf.add(
        10,
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {LETTER[0]} {LETTER[1]}] "
        f"/Resources << /Font << /F1 3 0 R >> >> /Contents 11 0 R /Deep {deep} >>",
    )
    pdf.add(11, stream(b"", content(1, LETTER)))
    return pdf.write("/Root 1 0 R"), None


FILES = {
    "plain.pdf": (plain, "A plain three-page PDF: Letter, A4 and a small page."),
    "rotated.pdf": (rotated, "Already rotated: one page inherits 180 from its tree, one sets 90."),
    "nested.pdf": (nested, "A two-level page tree with inherited MediaBox, Resources and Rotate."),
    "encrypted.pdf": (encrypted, "A password (/Encrypt): refused."),
    "signed.pdf": (signed, "A signature field with a /ByteRange: a warning."),
    "unsigned-field.pdf": (unsigned_field, "An empty signature field: a form, not a signature."),
    "outline-form.pdf": (outline_form, "Bookmarks and a text field: a warning."),
    "damaged.pdf": (damaged, "Cut off before its catalog: refused as damaged."),
    "truncated-tail.pdf": (truncated_tail, "Its cross-reference table cut off: read anyway."),
    "object-streams.pdf": (object_streams, "Object streams and a cross-reference stream."),
    "incremental.pdf": (incremental, "An incremental update that rotates page 1 and adds page 3."),
    "tree-cycle.pdf": (tree_cycle, "A page tree that points back at itself: refused."),
    "reference-cycle.pdf": (reference_cycle, "Resources that reach themselves: copied once."),
    "deep-tree.pdf": (deep_tree, "A page tree 300 levels deep: refused."),
    "deep-array.pdf": (deep_array, "Arrays nested 50,000 deep in the page: refused."),
}

FLAGS = {
    "signed.pdf": {"signed": True, "outline": False, "form": True},
    "unsigned-field.pdf": {"signed": False, "outline": False, "form": True},
    "outline-form.pdf": {"signed": False, "outline": True, "form": True},
}

REFUSED = {
    "encrypted.pdf": "encrypted",
    "damaged.pdf": "damaged",
    "tree-cycle.pdf": "damaged",
    "deep-tree.pdf": "damaged",
    "deep-array.pdf": "damaged",
}


def operations(files):
    """Plans both engines run, each output as pages (file, page index, rotation set), and what
    each output must read back as: its pages' sizes and /Rotate, in order."""

    def page(name, index, rotate=None):
        source = files[name][index]
        return {
            "file": name,
            "page": index,
            "rotate": source["rotate"] if rotate is None else rotate,
        }

    def expect(pages):
        return [
            {
                "width": files[p["file"]][p["page"]]["width"],
                "height": files[p["file"]][p["page"]]["height"],
                "rotate": p["rotate"],
            }
            for p in pages
        ]

    plans = {
        "rotate page 2 of plain": [[page("plain.pdf", 0), page("plain.pdf", 1, 90), page("plain.pdf", 2)]],
        "reorder plain 3, 1, 2": [[page("plain.pdf", 2), page("plain.pdf", 0), page("plain.pdf", 1)]],
        "remove page 2 of plain": [[page("plain.pdf", 0), page("plain.pdf", 2)]],
        "split plain into 1-2 and 3": [
            [page("plain.pdf", 0), page("plain.pdf", 1)],
            [page("plain.pdf", 2)],
        ],
        "split rotated per page": [[page("rotated.pdf", 0)], [page("rotated.pdf", 1)]],
        "rotate the rotated back upright": [[page("rotated.pdf", 0, 0), page("rotated.pdf", 1, 0)]],
        "merge plain, rotated and nested": [
            [page("plain.pdf", i) for i in range(3)]
            + [page("rotated.pdf", i) for i in range(2)]
            + [page("nested.pdf", i) for i in range(3)]
        ],
        "merge object streams and incremental, reversed": [
            [page("incremental.pdf", i) for i in (2, 1, 0)] + [page("object-streams.pdf", i) for i in (2, 1, 0)]
        ],
        "copy the reference cycle": [[page("reference-cycle.pdf", 0, 90)]],
        "copy the signed and the form": [[page("signed.pdf", 0), page("outline-form.pdf", 1), page("outline-form.pdf", 0)]],
        "copy the truncated": [[page("truncated-tail.pdf", 2), page("truncated-tail.pdf", 0)]],
    }
    return [
        {
            "name": name,
            "outputs": [{"pages": pages, "expected": expect(pages)} for pages in outputs],
        }
        for name, outputs in plans.items()
    ]


def main():
    cases = []
    pages_of = {}
    for name, (make, note) in FILES.items():
        data, pages = make()
        with open(os.path.join(HERE, name), "wb") as f:
            f.write(data)
        refused = REFUSED.get(name)
        case = {"file": name, "note": note, "sha256": hashlib.sha256(data).hexdigest()}
        if refused:
            case["outcome"] = refused
        else:
            case["outcome"] = "ok"
            case["pages"] = pages
            case.update(FLAGS.get(name, {"signed": False, "outline": False, "form": False}))
            pages_of[name] = pages
        cases.append(case)
    expected = {
        "canary": CANARY,
        "infoCanary": INFO_CANARY,
        "files": cases,
        "operations": operations(pages_of),
    }
    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(expected, f, indent=1, ensure_ascii=False)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
