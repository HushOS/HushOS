/*
 * Keys that stay the person's own while the app holds the keyboard (signing out, the drive
 * still opening): moving focus, Escape and reloading.
 */
export const passesThrough = (event: KeyboardEvent) =>
    event.key === 'Tab' ||
    event.key === 'Escape' ||
    event.key === 'F5' ||
    ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r');
