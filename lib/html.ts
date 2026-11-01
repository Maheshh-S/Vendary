/**
 * Minimal HTML escaping for the hand-built transactional templates.
 *
 * Everything inserted into an email body is order/user-owned text (product
 * names, address lines, statuses), so it is escaped at the point of
 * interpolation rather than trusted.
 */
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
