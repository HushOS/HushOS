import { play, setEnabled, setVolume, type SoundName } from 'cuelume';
import { useSyncExternalStore } from 'react';

/*
 * Sound confirms that something happened: a copy landed, a share stopped, a
 * step failed. Nothing sounds for a hover or a press, because nothing has
 * happened yet, and nothing sounds at all until the person turns sound on:
 * it is off until asked for. HushOS owns the preference; Cuelume plays the
 * cues, all of them from code via `cue()` so every flow sounds the same.
 */

const STORAGE_KEY = 'hushos-sounds';
const DEFAULT_VOLUME = 0.55;
const listeners = new Set<() => void>();
let enabled = false;
let ready = false;

function readPreference() {
    try {
        return window.localStorage.getItem(STORAGE_KEY) === 'on';
    } catch {
        return false;
    }
}

function emit() {
    for (const listener of listeners) listener();
}

export function initSounds() {
    if (typeof window === 'undefined' || ready) return;
    ready = true;
    enabled = readPreference();
    setEnabled(enabled);
    setVolume(DEFAULT_VOLUME);
}

export function setSoundsEnabled(value: boolean) {
    enabled = value;
    setEnabled(value);
    try {
        window.localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
    } catch {
        /* Preference simply won't persist. */
    }
    emit();
    if (value) play('toggle', { volume: 0.5 });
}

export function cue(name: SoundName, options?: { volume?: number }) {
    if (typeof window === 'undefined') return;
    play(name, options);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useSoundsEnabled() {
    return useSyncExternalStore(
        subscribe,
        () => enabled,
        () => false,
    );
}
