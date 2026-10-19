import { defineJob } from '@ondes/queue';
import { z } from 'zod';

export default defineJob('not-hello', z.object({}), () => {});
