import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function getOgImageUrl(title: string) {
    return `/api/og-image?title=${encodeURIComponent(title)}`;
}

export function downloadViaAnchor(data: string, fileName: string) {
    const blob = new Blob([data], { type: 'text/plain' });
    const blobUrl = URL.createObjectURL(blob);
    const aTag = document.createElement('a');
    aTag.setAttribute('href', blobUrl);
    aTag.setAttribute('download', fileName);
    document.body.appendChild(aTag);
    aTag.click();
    document.body.removeChild(aTag);
    URL.revokeObjectURL(blobUrl);
}
