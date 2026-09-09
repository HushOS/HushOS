// Makes an accidental browser import of a server module fail at load.
if (typeof window !== 'undefined')
    throw new Error('A server-only module was imported into the browser build.');
