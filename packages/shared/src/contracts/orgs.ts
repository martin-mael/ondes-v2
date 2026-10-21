import { z } from 'zod';
import { ianaTimezoneSchema, roleSchema, slugSchema, uuidSchema } from './tenancy.ts';

// What the signed-in user can open (#9): their orgs and, in each, the stations they can reach.
// Feeds the web app's org/station switcher (`GET /api/v1/orgs`).

export const myStationSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  timezone: ianaTimezoneSchema,
  /** Highest role that applies to this station (org roles included). */
  role: roleSchema,
});

export const myOrgSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: z.string(),
  /** The user's org-level role, or `null` if they only belong to some stations. */
  role: roleSchema.nullable(),
  stations: z.array(myStationSchema),
});

export const myOrgsResponseSchema = z.object({ orgs: z.array(myOrgSchema) });

export type MyStation = z.infer<typeof myStationSchema>;
export type MyOrg = z.infer<typeof myOrgSchema>;
export type MyOrgsResponse = z.infer<typeof myOrgsResponseSchema>;
