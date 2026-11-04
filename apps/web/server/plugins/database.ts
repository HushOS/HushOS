import { endPools } from '@hushos/db';
import { definePlugin } from 'nitro';

export default definePlugin((nitroApp) => {
    nitroApp.hooks.hook('close', () => endPools());
});
