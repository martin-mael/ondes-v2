import { hash, verify } from '@node-rs/argon2';

// argon2id with OWASP's baseline parameters (19 MiB, 2 passes, 1 lane). The library's default
// algorithm is argon2id; the PHC string records the parameters, so they can be raised later.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Burns the same time as a real check, so unknown emails can't be told apart by timing. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword('ondes-dummy-password');
  await verifyPassword(await dummyHash, password);
  return false;
}
