import { QRCodeSVG } from 'qrcode.react';
import { logoSvg } from '@/lib/brand';

/*
 * A QR code with the HushOS mark in the middle, so a code from this app is
 * recognisable as one: the white mark on a black rounded square, the mark's
 * own portrait centred. What a code holds is said beside it, never by the mark.
 */
const mark = `data:image/svg+xml;utf8,${encodeURIComponent(logoSvg('#ffffff', '#000000', 96))}`;

export function QrCode({
    value,
    size = 176,
    title,
}: {
    value: string;
    /* Kept for call sites that name what they encode; the mark itself is the same. */
    kind?: 'share' | 'recovery';
    size?: number;
    title: string;
}) {
    const box = Math.round(size * 0.24);
    return (
        <QRCodeSVG
            value={value}
            size={size}
            marginSize={1}
            level="H"
            title={title}
            imageSettings={{ src: mark, width: box, height: box, excavate: true }}
        />
    );
}
