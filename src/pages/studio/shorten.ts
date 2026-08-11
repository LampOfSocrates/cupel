/** One-line preview of a prompt or turn body, for the Studio's list rows. */
export function shorten(text: string, max = 64) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
