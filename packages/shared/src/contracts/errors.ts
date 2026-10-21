import { z } from 'zod';

// Error body of every non-2xx api response (#6). `error` is a stable machine code
// (`not_found`, `forbidden`, `two_factor_required`, …); `message` is for humans.

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
