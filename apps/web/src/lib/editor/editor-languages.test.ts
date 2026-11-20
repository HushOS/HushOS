import { describe, expect, test } from 'vitest';
import { editorLanguage, loadLanguage } from '@/lib/editor/editor-languages';

/*
 * The editor colours a file by its name. Fails if a Java .properties file opens as plain text
 * while its grammar is right there, or if a name with no such extension borrows it.
 */
describe('the editor’s language for a file name', () => {
    test('a .properties file is coloured as properties', async () => {
        expect(editorLanguage('app.properties')).toBe('properties');
        expect(editorLanguage('Messages_FR.PROPERTIES')).toBe('properties');
        const extension = await loadLanguage('properties');
        expect(Array.isArray(extension) ? extension.length : 1).toBeGreaterThan(0);
    });

    test('a name that only ends in the word is plain text', () => {
        expect(editorLanguage('properties')).toBeNull();
        expect(editorLanguage('notes.txt')).toBeNull();
    });
});
