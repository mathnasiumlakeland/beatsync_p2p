import { nanoid } from "nanoid";
let clientId: string | null = null;
/** A fresh identity per tab avoids two tabs overwriting the same speaker. */
export function getClientId(): string {
  return (clientId ??= nanoid());
}
