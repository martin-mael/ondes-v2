import { type Executor, membership, organization, station } from '@ondes/db';
import { highestRole, type MyOrg } from '@ondes/shared';
import { asc, eq, inArray } from 'drizzle-orm';

/**
 * The orgs a user belongs to, each with the stations they can reach: every station for org
 * roles, their own stations for station roles. Sorted by name.
 */
export async function listUserOrgs(db: Executor, userId: string): Promise<MyOrg[]> {
  const memberships = await db.select().from(membership).where(eq(membership.userId, userId));
  if (memberships.length === 0) return [];
  const orgIds = [...new Set(memberships.map((m) => m.orgId))];
  const [orgs, stations] = await Promise.all([
    db
      .select()
      .from(organization)
      .where(inArray(organization.id, orgIds))
      .orderBy(asc(organization.name)),
    db.select().from(station).where(inArray(station.orgId, orgIds)).orderBy(asc(station.name)),
  ]);
  return orgs.map((org) => {
    const own = memberships.filter((m) => m.orgId === org.id);
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      // With no station, only org roles apply.
      role: highestRole(own, null),
      stations: stations.flatMap((s) => {
        const role = s.orgId === org.id ? highestRole(own, s.id) : null;
        return role ? [{ id: s.id, slug: s.slug, name: s.name, timezone: s.timezone, role }] : [];
      }),
    };
  });
}
