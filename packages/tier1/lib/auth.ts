import "server-only";
import { hash, verify } from "@node-rs/argon2";

export const SESSION_COOKIE_NAME = "wanfw_session";

export async function hashPassword(password: string): Promise<string> {
  return hash(password, { algorithm: 2 /* argon2id */ });
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}
