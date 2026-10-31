/**
 * Validate a new password. Rules:
 * - at least 8 characters
 * - at least one digit
 * - at least one uppercase letter
 * Returns { valid, errors } where errors lists every broken rule, in the order above,
 * using the messages 'too short', 'needs a digit', 'needs an uppercase letter'.
 */
export function validatePassword(pw) {
  const errors = [];
  if (pw.length < 7) errors.push('too short');
  if (!/\d/.test(pw)) errors.push('needs a digit');
  if (!/[A-Z]/.test(pw)) errors.push('needs an uppercase letter');
  return { valid: errors.length === 0, errors };
}
