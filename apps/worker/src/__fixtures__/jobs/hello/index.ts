import { defineJob } from '@ondes/queue';
import { z } from 'zod';

export default defineJob('hello', z.object({ name: z.string() }), () => {}, { lane: 'high' });

export const triggers = [{ queue: 'worker.hello', onEvent: async () => {} }];
