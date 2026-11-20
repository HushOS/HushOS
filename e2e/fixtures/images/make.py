"""
The images-to-PDF fixtures of docs/file-tools-design.md, feature (b): real JPEGs, encoded by
libjpeg (through Pillow, and cjpeg for restart markers and arithmetic coding), with metadata
segments written byte by byte around them. The web's cutter (apps/web/src/lib/images-pdf/jpeg.ts)
and the core's (crates/hushos-core/src/tools/images_pdf.rs) are both held to expected.json here.

What a cutter must make of each file is worked out here, independently of either cutter: every
fixture is built from parts this script labels kept or dropped, and the expected output is the
kept parts joined (with an end-of-image marker added where the file stops inside the image's
data). So a cutter that keeps a segment it should drop, or cuts one byte too many, fails on the
SHA-256, not only on a search for "Exif".

geometry.json holds page sizes and placement matrices for the same rules (page size, margins,
the eight EXIF orientations), computed here from the definitions, not by either twin.

    python3 -I e2e/fixtures/images/make.py

Deterministic: a rewrite that changes a committed file's bytes is a change to review (a Pillow
or libjpeg upgrade can do that; the expected outcomes are recomputed with it).
"""

import hashlib
import io
import json
import os
import random
import struct
import subprocess
import sys
import tempfile

from PIL import Image, ImageCms, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# What a test looks for in a PDF: none of these may be inside it.
CANARY_MAKE = b"HushCanaryCam"
CANARY_XMP = b"HUSHOS-CANARY-XMP-7d41"
CANARY_IPTC = b"HUSHOS-CANARY-IPTC-2c90"
CANARY_COMMENT = b"HUSHOS-CANARY-COM-913a"
CANARY_TRAILER = b"HUSHOS-CANARY-MPF-4e07"
CANARY_JFIF = b"HUSHOS-CANARY-JFIF-8c2b"
CANARY_ADOBE = b"HUSHOS-CANARY-ADOBE-51d7"
# The GPS latitude 51 deg 30' 26.5" as little-endian rationals, the bytes a GPS IFD carries.
GPS_LATITUDE_LE = struct.pack("<6I", 51, 1, 30, 1, 2650, 100)
GPS_LATITUDE_BE = struct.pack(">6I", 51, 1, 30, 1, 2650, 100)


# ---------------------------------------------------------------------------------------------
# Segments
# ---------------------------------------------------------------------------------------------


def seg(marker, payload):
    return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload


def split(jpeg):
    """A libjpeg file as (header segments before the first SOS, everything from the SOS on)."""
    assert jpeg[:2] == b"\xff\xd8"
    pos = 2
    segments = []
    while True:
        assert jpeg[pos] == 0xFF
        marker = jpeg[pos + 1]
        if marker == 0xDA:
            return segments, jpeg[pos:]
        length = struct.unpack(">H", jpeg[pos + 2 : pos + 4])[0]
        segments.append(jpeg[pos : pos + 2 + length])
        pos += 2 + length


def kept_header(segment):
    """The rule both cutters follow, stated once here for the libjpeg segments a fixture starts from."""
    marker = segment[1]
    payload = segment[4:]
    if marker == 0xE0:
        return payload.startswith(b"JFIF\x00")
    if marker == 0xE2:
        return payload.startswith(b"ICC_PROFILE\x00")
    if marker == 0xEE:
        return payload.startswith(b"Adobe")
    if 0xE0 <= marker <= 0xEF or marker == 0xFE:
        return False
    return True


class Fixture:
    def __init__(self):
        self.parts = []  # (bytes, kept)

    def add(self, data, kept):
        self.parts.append((data, kept))
        return self

    def file(self):
        return b"".join(part for part, _ in self.parts)

    def expected(self):
        # `kept` is True (as it is), False (cut), or the bytes the cutter writes in its place.
        return b"".join(part if kept is True else kept for part, kept in self.parts if kept)


def from_libjpeg(jpeg, extra_after_jfif=(), extra_before_sos=()):
    segments, scan = split(jpeg)
    fixture = Fixture().add(b"\xff\xd8", True)
    inserted = False
    for segment in segments:
        fixture.add(segment, kept_header(segment))
        if segment[1] == 0xE0 and not inserted:
            for data, kept in extra_after_jfif:
                fixture.add(data, kept)
            inserted = True
    if not inserted:
        for data, kept in extra_after_jfif:
            fixture.add(data, kept)
    for data, kept in extra_before_sos:
        fixture.add(data, kept)
    fixture.add(scan, True)
    return fixture


# ---------------------------------------------------------------------------------------------
# EXIF, XMP, IPTC
# ---------------------------------------------------------------------------------------------


def tiff(orientation=1, big_endian=False, gps=True, make=CANARY_MAKE):
    """A TIFF block as EXIF carries it: IFD0 with Make, Model, Orientation and a GPS IFD."""
    e = ">" if big_endian else "<"
    header = (b"MM" if big_endian else b"II") + struct.pack(e + "HI", 42, 8)
    make_value = make + b"\x00"
    model_value = b"Canary One\x00"
    entries = 3 + (1 if gps else 0)
    ifd0_size = 2 + entries * 12 + 4
    data_at = 8 + ifd0_size
    make_at = data_at
    model_at = make_at + len(make_value)
    gps_at = model_at + len(model_value)
    if gps_at % 2:
        gps_at += 1
    ifd0 = struct.pack(e + "H", entries)
    ifd0 += struct.pack(e + "HHII", 0x010F, 2, len(make_value), make_at)
    ifd0 += struct.pack(e + "HHII", 0x0110, 2, len(model_value), model_at)
    ifd0 += struct.pack(e + "HHI", 0x0112, 3, 1) + struct.pack(e + "HH", orientation, 0)
    if gps:
        ifd0 += struct.pack(e + "HHII", 0x8825, 4, 1, gps_at)
    ifd0 += struct.pack(e + "I", 0)
    body = header + ifd0 + make_value + model_value
    body += b"\x00" * (gps_at - len(body))
    if gps:
        gps_entries = 4
        values_at = gps_at + 2 + gps_entries * 12 + 4
        gps_ifd = struct.pack(e + "H", gps_entries)
        gps_ifd += struct.pack(e + "HHI", 0x0001, 2, 2) + b"N\x00\x00\x00"
        gps_ifd += struct.pack(e + "HHII", 0x0002, 5, 3, values_at)
        gps_ifd += struct.pack(e + "HHI", 0x0003, 2, 2) + b"W\x00\x00\x00"
        gps_ifd += struct.pack(e + "HHII", 0x0004, 5, 3, values_at + 24)
        gps_ifd += struct.pack(e + "I", 0)
        latitude = GPS_LATITUDE_BE if big_endian else GPS_LATITUDE_LE
        longitude = struct.pack(e + "6I", 0, 1, 7, 1, 3960, 100)
        body += gps_ifd + latitude + longitude
    return body


def exif(**options):
    return seg(0xE1, b"Exif\x00\x00" + tiff(**options))


def xmp():
    packet = (
        b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"'
        b' exif:GPSLatitude="51,30.44N" exif:GPSLongitude="0,7.66W" photoshop:City="' + CANARY_XMP + b'"/>'
        b'</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
    )
    standard = seg(0xE1, b"http://ns.adobe.com/xap/1.0/\x00" + packet)
    # Extended XMP: a GUID, the full length, this chunk's offset, then the chunk.
    extension = b"http://ns.adobe.com/xmp/extension/\x00" + b"0" * 32 + struct.pack(">II", 24, 0)
    extended = seg(0xE1, extension + b"<x>" + CANARY_XMP + b"</x>")
    return standard, extended


def iptc():
    city = CANARY_IPTC
    record = b"\x1c\x02\x5a" + struct.pack(">H", len(city)) + city  # 2:90 City
    resource = b"8BIM" + struct.pack(">H", 0x0404) + b"\x00\x00" + struct.pack(">I", len(record)) + record
    if len(record) % 2:
        resource += b"\x00"
    return seg(0xED, b"Photoshop 3.0\x00" + resource)


# ---------------------------------------------------------------------------------------------
# Pictures
# ---------------------------------------------------------------------------------------------


def upright(width, height, mode="RGB"):
    """What a person sees: red along the top, green down the left, blue at bottom right."""
    image = Image.new("RGB", (width, height), (235, 235, 230))
    draw = ImageDraw.Draw(image)
    band = max(4, height // 6)
    draw.rectangle([0, 0, width - 1, band - 1], fill=(220, 20, 20))
    draw.rectangle([0, band, max(4, width // 8) - 1, height - 1], fill=(20, 160, 40))
    draw.rectangle([width * 3 // 4, height * 3 // 4, width - 1, height - 1], fill=(30, 60, 220))
    return image.convert(mode) if mode != "RGB" else image


# The inverse of each EXIF orientation: what is stored so that applying the orientation shows `upright`.
STORED = {
    1: None,
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_90,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_270,
}


def stored(image, orientation):
    op = STORED[orientation]
    return image if op is None else image.transpose(op)


def encode(image, **options):
    out = io.BytesIO()
    image.save(out, "JPEG", quality=88, **options)
    return out.getvalue()


def cjpeg(image, *args):
    with tempfile.TemporaryDirectory() as tmp:
        ppm = os.path.join(tmp, "in.ppm")
        image.save(ppm)
        return subprocess.run(["cjpeg", "-quality", "85", *args, ppm], check=True, capture_output=True).stdout


def sof(jpeg):
    pos = 2
    while True:
        marker = jpeg[pos + 1]
        length = struct.unpack(">H", jpeg[pos + 2 : pos + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC9, 0xCA):
            height, width = struct.unpack(">HH", jpeg[pos + 5 : pos + 9])
            return width, height, jpeg[pos + 9]
        pos += 2 + length


# ---------------------------------------------------------------------------------------------
# The fixtures
# ---------------------------------------------------------------------------------------------

cases = []


def write(name, data):
    with open(os.path.join(HERE, name), "wb") as f:
        f.write(data)


def icc_of(jpeg, components):
    """The ICC profile a PDF may use as the image's colour space: every APP2 ICC_PROFILE chunk present
    once and in sequence, its declared length and `acsp` signature right, its colour space matching
    the image's components. None otherwise (the writers fall back to the device space)."""
    segments, _ = split(jpeg)
    chunks = {}
    count = None
    for segment in segments:
        payload = segment[4:]
        if segment[1] != 0xE2 or not payload.startswith(b"ICC_PROFILE\x00") or len(payload) < 14:
            continue
        seq, total = payload[12], payload[13]
        if seq == 0 or seq > total or seq in chunks or (count is not None and total != count):
            return None
        count = total
        chunks[seq] = payload[14:]
    if not chunks or sorted(chunks) != list(range(1, count + 1)):
        return None
    profile = b"".join(chunks[i] for i in range(1, count + 1))
    if len(profile) < 128 or struct.unpack(">I", profile[:4])[0] != len(profile) or profile[36:40] != b"acsp":
        return None
    spaces = {b"GRAY": 1, b"RGB ": 3, b"CMYK": 4}
    if spaces.get(profile[16:20]) != components:
        return None
    return profile


def ok(name, fixture, orientation=1, adobe=False, eoi_added=False, note=""):
    data = fixture.file()
    expected = fixture.expected() + (b"\xff\xd9" if eoi_added else b"")
    write(name, data)
    # Cutting is lossless: the cut file decodes to the very pixels the whole file does.
    if not eoi_added:
        assert Image.open(io.BytesIO(data)).tobytes() == Image.open(io.BytesIO(expected)).tobytes(), name
    width, height, components = sof(expected)
    cases.append(
        {
            "file": name,
            "outcome": "ok",
            "sha256": hashlib.sha256(expected).hexdigest(),
            "length": len(expected),
            "width": width,
            "height": height,
            "components": components,
            "orientation": orientation,
            "adobe": adobe,
            "icc": (lambda profile: profile and {"n": components, "sha256": hashlib.sha256(profile).hexdigest()})(
                icc_of(expected, components)
            ),
            "note": note,
        }
    )


def refused(name, data, outcome, note=""):
    write(name, data)
    cases.append({"file": name, "outcome": outcome, "note": note})


def main():
    # The base pictures.
    photo = upright(240, 160)

    plain = from_libjpeg(encode(photo))
    ok("plain.jpg", plain, note="JFIF only: unchanged")

    ok(
        "gps.jpg",
        from_libjpeg(encode(photo), [(exif(), False)]),
        note="EXIF with GPS, Make and Model: dropped",
    )

    standard, extended = xmp()
    ok("xmp.jpg", from_libjpeg(encode(photo), [(standard, False), (extended, False)]), note="XMP and extended XMP: dropped")

    ok("iptc.jpg", from_libjpeg(encode(photo), [(iptc(), False)]), note="IPTC in Photoshop APP13: dropped")

    srgb = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    srgb[24:36] = struct.pack(">6H", 2026, 11, 19, 0, 0, 0)  # a fixed creation date
    srgb = bytes(srgb)
    ok(
        "icc.jpg",
        from_libjpeg(encode(photo, icc_profile=srgb), [(exif(), False)]),
        note="ICC profile kept, EXIF dropped",
    )

    # An ICC chunk numbered past its own count (2 of 1): kept as a segment, never used, never a crash.
    segments, scan = split(encode(photo))
    bad_seq = Fixture().add(b"\xff\xd8", True)
    for segment in segments:
        bad_seq.add(segment, kept_header(segment))
    bad_seq.add(seg(0xE2, b"ICC_PROFILE\x00\x02\x01" + srgb), True)
    bad_seq.add(scan, True)
    ok("icc-bad-sequence.jpg", bad_seq, note="ICC chunk 2 of 1: the device space instead")

    # An RGB profile on a greyscale JPEG: kept as a segment, but no use as the image's colour space.
    ok(
        "icc-mismatch.jpg",
        from_libjpeg(encode(upright(120, 90, "L"), icc_profile=srgb)),
        note="an RGB profile on one component: the device space instead",
    )

    cmyk = encode(upright(200, 120, "CMYK"))
    ok(
        "adobe-cmyk.jpg",
        from_libjpeg(cmyk, [(exif(), False)]),
        adobe=True,
        note="CMYK with the Adobe marker kept, EXIF dropped",
    )

    # An Adobe marker with application data after its 12 bytes: the marker stays, rewritten to them.
    segments, scan = split(cmyk)
    trailing = Fixture().add(b"\xff\xd8", True)
    for segment in segments:
        if segment[1] == 0xEE:
            payload = segment[4:]
            assert len(payload) == 12, len(payload)
            trailing.add(seg(0xEE, payload + CANARY_ADOBE), seg(0xEE, payload))
        else:
            trailing.add(segment, kept_header(segment))
    trailing.add(scan, True)
    ok("adobe-trailing.jpg", trailing, adobe=True, note="APP14 Adobe with trailing data: its 12 bytes kept, the rest cut")

    # CMYK without the Adobe marker: samples in the plain sense (ink 0 is none), as some tools
    # write it. Pillow stores Adobe's complemented samples, so the picture is complemented first
    # and the marker left out: the file then reads right without it.
    from PIL import ImageChops

    plain_cmyk = encode(ImageChops.invert(upright(200, 120, "CMYK")))
    segments, scan = split(plain_cmyk)
    no_adobe = Fixture().add(b"\xff\xd8", True)
    for segment in segments:
        if segment[1] != 0xEE:
            no_adobe.add(segment, kept_header(segment))
    no_adobe.add(exif(), False)
    no_adobe.add(scan, True)
    ok("plain-cmyk.jpg", no_adobe, note="CMYK without the Adobe marker: not complemented")

    ok("grey.jpg", from_libjpeg(encode(upright(120, 90, "L")), [(exif(), False)]), note="one component")

    comment = seg(0xFE, b"Shot on a " + CANARY_COMMENT)
    progressive = encode(photo, progressive=True)
    ok(
        "progressive.jpg",
        from_libjpeg(progressive, [(exif(), False), (standard, False), (comment, False)]),
        note="progressive, EXIF, XMP and a comment dropped",
    )

    # A segment between two scans of a progressive JPEG: a cutter that stops looking at the first
    # scan would let it through.
    segments, scan = split(progressive)
    pos = 2 + struct.unpack(">H", scan[2:4])[0]
    while not (scan[pos] == 0xFF and scan[pos + 1] not in (0x00, *range(0xD0, 0xD8), 0xFF)):
        pos += 1
    between = Fixture().add(b"\xff\xd8", True)
    for segment in segments:
        between.add(segment, kept_header(segment))
    between.add(scan[:pos], True)
    between.add(exif(), False)
    between.add(comment, False)
    between.add(scan[pos:], True)
    ok("between-scans.jpg", between, note="EXIF and a comment between scans: dropped")

    # Orientations: each stored so that applying it shows `upright`. 6 is the phone photo.
    for orientation in range(1, 9):
        big_endian = orientation in (3, 8)
        ok(
            f"orientation-{orientation}.jpg",
            from_libjpeg(
                encode(stored(upright(60, 40), orientation)),
                [(exif(orientation=orientation, big_endian=big_endian), False)],
            ),
            orientation=orientation,
            note="big-endian TIFF" if big_endian else "",
        )
    ok(
        "phone-rotated.jpg",
        from_libjpeg(encode(stored(upright(400, 300), 6)), [(exif(orientation=6), False)]),
        orientation=6,
        note="a phone photo held upright: stored sideways, orientation 6, with GPS",
    )

    # A JFIF header carrying its own thumbnail (raw RGB, here spelling a canary): a second picture
    # the page never shows. The header stays, rewritten to its 16 bytes with no thumbnail; version,
    # units and density are kept.
    segments, scan = split(encode(photo))
    pixels = (CANARY_JFIF * 2)[: 4 * 3 * 3]
    jfif_payload = b"JFIF\x00" + b"\x01\x02" + b"\x01" + struct.pack(">HH", 300, 300) + b"\x04\x03" + pixels
    canonical = seg(0xE0, jfif_payload[:12] + b"\x00\x00")
    thumbnailed = Fixture().add(b"\xff\xd8", True).add(seg(0xE0, jfif_payload), canonical)
    for segment in segments:
        if segment[1] != 0xE0:
            thumbnailed.add(segment, kept_header(segment))
    thumbnailed.add(scan, True)
    ok("jfif-thumbnail.jpg", thumbnailed, note="a JFIF thumbnail: the header kept, its thumbnail cut")

    # Two EXIF blocks that disagree: the first decides, as browsers decide.
    ok(
        "two-exif.jpg",
        from_libjpeg(
            encode(stored(upright(60, 40), 6)),
            [(exif(orientation=6, gps=False), False), (exif(orientation=3), False)],
        ),
        orientation=6,
        note="the first EXIF block's orientation, both dropped",
    )

    # The second image of a multi-picture file (MPF), after the end of the first: dropped, its
    # own EXIF with it.
    secondary = from_libjpeg(encode(upright(32, 24)), [(exif(make=CANARY_TRAILER), True)]).file()
    mpf = seg(0xE2, b"MPF\x00" + b"MM\x00\x2a\x00\x00\x00\x08" + b"\x00" * 16)
    trailing = from_libjpeg(encode(photo), [(mpf, False), (exif(), False)])
    trailing.add(secondary, False)
    ok("mpf-trailer.jpg", trailing, note="MPF in APP2 and a second image after the end: dropped")

    # Other application segments, a JFXX thumbnail, a comment, and fill bytes before a marker.
    segments, scan = split(encode(photo))
    other = Fixture().add(b"\xff\xd8", True)
    for segment in segments:
        if segment[1] == 0xDB:
            other.add(b"\xff\xff", False)  # fill bytes: legal, and not part of any segment
        other.add(segment, kept_header(segment))
    other.add(seg(0xE0, b"JFXX\x00\x10" + encode(upright(16, 12))), False)
    other.add(seg(0xE3, b"Meta" + CANARY_MAKE), False)
    other.add(seg(0xEC, b"Ducky" + b"\x00" * 8), False)
    other.add(seg(0xEF, CANARY_MAKE), False)
    other.add(comment, False)
    other.add(scan, True)
    ok("other-segments.jpg", other, note="APP3, APP12, APP15, JFXX, a comment and fill bytes: dropped")

    restart = cjpeg(photo, "-restart", "1", "-progressive")
    ok("restart.jpg", from_libjpeg(restart, [(exif(), False)]), note="restart markers inside the scans")

    # Damaged and refused.
    gps_file = from_libjpeg(encode(photo), [(exif(), False)]).file()
    exif_at = gps_file.index(b"Exif")
    refused("truncated-segment.jpg", gps_file[: exif_at + 40], "damaged", "ends inside the EXIF segment")

    base = encode(photo)
    segments, scan = split(base)
    header_length = len(base) - len(scan)
    cut = header_length + len(scan) // 2
    while base[cut - 1] == 0xFF:
        cut -= 1
    truncated = Fixture().add(b"\xff\xd8", True)
    for segment in segments:
        truncated.add(segment, kept_header(segment))
    truncated.add(base[header_length:cut], True)
    ok("truncated-scan.jpg", truncated, eoi_added=True, note="ends inside the image data: kept, end marker added")

    refused("arithmetic.jpg", cjpeg(photo, "-arithmetic"), "unsupported", "arithmetic coding (SOF9)")
    refused("empty.jpg", b"", "damaged", "no bytes")
    refused("soi-eoi.jpg", b"\xff\xd8\xff\xd9", "damaged", "no picture")
    rng = random.Random(7)
    refused("garbage.jpg", bytes(rng.getrandbits(8) for _ in range(4096)), "damaged", "random bytes")
    refused("garbage-after-soi.jpg", b"\xff\xd8" + bytes(rng.getrandbits(8) for _ in range(512)), "damaged")
    png = io.BytesIO()
    photo.save(png, "PNG")
    refused("png-named-jpg.jpg", png.getvalue(), "damaged", "a PNG")
    short = bytearray(gps_file)
    short[exif_at - 2 : exif_at] = b"\x00\x01"
    refused("bad-length.jpg", bytes(short), "damaged", "a segment length of 1")
    no_sof = b"\xff\xd8" + b"".join(s for s in split(base)[0] if s[1] not in range(0xC0, 0xC3)) + split(base)[1]
    refused("no-frame.jpg", no_sof, "damaged", "a scan before any frame header")
    dnl = bytearray(base)
    sof_at = dnl.index(b"\xff\xc0")
    dnl[sof_at + 5 : sof_at + 7] = b"\x00\x00"
    refused("zero-height.jpg", bytes(dnl), "unsupported", "height 0 (set later by DNL)")

    garbled = bytearray(exif())
    garbled[14:18] = b"\xff\xff\xff\x7f"  # IFD0 offset far past the segment
    ok("exif-garbled.jpg", from_libjpeg(encode(photo), [(bytes(garbled), False)]), note="unreadable EXIF: orientation 1, dropped")

    # Other inputs for the writers and the e2e suite (not cutter cases).
    trio = [upright(300, 200), upright(200, 300), upright(250, 250)]
    for index, image in enumerate(trio):
        with open(os.path.join(HERE, f"page-{index + 1}.jpg"), "wb") as f:
            f.write(encode(image))
    alpha = Image.new("RGBA", (64, 48), (0, 0, 0, 0))
    ImageDraw.Draw(alpha).ellipse([4, 4, 59, 43], fill=(200, 30, 30, 255))
    alpha.save(os.path.join(HERE, "alpha.png"))
    photo.save(os.path.join(HERE, "photo.webp"), "WEBP", quality=90)
    photo.save(os.path.join(HERE, "photo-lossless.webp"), "WEBP", lossless=True)
    photo.save(os.path.join(HERE, "photo.gif"), "GIF")
    photo.save(os.path.join(HERE, "photo.bmp"), "BMP")

    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(
            {
                "canaries": {
                    "text": [s.decode() for s in (CANARY_MAKE, CANARY_XMP, CANARY_IPTC, CANARY_COMMENT, CANARY_TRAILER, CANARY_JFIF, CANARY_ADOBE)],
                    "gpsLatitudeHex": [GPS_LATITUDE_LE.hex(), GPS_LATITUDE_BE.hex()],
                },
                "cut": cases,
            },
            f,
            indent=2,
        )
        f.write("\n")
    geometry()


# ---------------------------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------------------------

PT_PER_MM = 72 / 25.4
MARGIN = 12 * PT_PER_MM
FIT_MAX = 14400  # the largest page side most readers accept, in points
PAPER = {"a4": (210 * PT_PER_MM, 297 * PT_PER_MM), "letter": (612.0, 792.0)}

# For each orientation, the shown position (X, Y) of a stored point (s, t), both in the unit
# square with y up: (dX/ds, dX/dt, X at 0; dY/ds, dY/dt, Y at 0).
AXES = {
    1: (1, 0, 0, 0, 1, 0),
    2: (-1, 0, 1, 0, 1, 0),
    3: (-1, 0, 1, 0, -1, 1),
    4: (1, 0, 0, 0, -1, 1),
    5: (0, -1, 1, -1, 0, 1),
    6: (0, 1, 0, -1, 0, 1),
    7: (0, 1, 0, 1, 0, 0),
    8: (0, -1, 1, 1, 0, 0),
}


def layout(width, height, orientation, size, margin):
    m = MARGIN if margin else 0.0
    shown_w, shown_h = (height, width) if orientation >= 5 else (width, height)
    if size == "fit":
        scale = 1.0
        if max(shown_w, shown_h) + 2 * m > FIT_MAX:
            scale = (FIT_MAX - 2 * m) / max(shown_w, shown_h)
        box_w, box_h = shown_w * scale, shown_h * scale
        page_w, page_h = box_w + 2 * m, box_h + 2 * m
        x, y = m, m
    else:
        page_w, page_h = PAPER[size]
        if shown_w > shown_h:
            page_w, page_h = page_h, page_w
        scale = min((page_w - 2 * m) / shown_w, (page_h - 2 * m) / shown_h)
        box_w, box_h = shown_w * scale, shown_h * scale
        x, y = (page_w - box_w) / 2, (page_h - box_h) / 2
    xs, xt, x0, ys, yt, y0 = AXES[orientation]
    matrix = [box_w * xs, box_h * ys, box_w * xt, box_h * yt, x + box_w * x0, y + box_h * y0]
    return {"page": [page_w, page_h], "matrix": [v + 0.0 for v in matrix]}


def geometry():
    cases = []
    for orientation in range(1, 9):
        for size in ("fit", "a4", "letter"):
            for margin in (False, True):
                for width, height in ((400, 300), (300, 400), (500, 500)):
                    cases.append(
                        {
                            "width": width,
                            "height": height,
                            "orientation": orientation,
                            "size": size,
                            "margin": margin,
                            **layout(width, height, orientation, size, margin),
                        }
                    )
    # Past the largest page: scaled down to fit it, margins included.
    for width, height, orientation in ((30000, 2000, 1), (2000, 30000, 6), (14400, 100, 1)):
        for margin in (False, True):
            cases.append(
                {
                    "width": width,
                    "height": height,
                    "orientation": orientation,
                    "size": "fit",
                    "margin": margin,
                    **layout(width, height, orientation, "fit", margin),
                }
            )
    with open(os.path.join(HERE, "geometry.json"), "w") as f:
        json.dump({"cases": cases}, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
