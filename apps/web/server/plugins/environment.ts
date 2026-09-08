import { validateServerEnv } from '@hushos/env/server';
import { definePlugin } from 'nitro';

export default definePlugin(() => {
    validateServerEnv();
});
