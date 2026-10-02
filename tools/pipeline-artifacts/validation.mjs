import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OUTPUT_SEGMENT_PATTERN = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateStrictObject(value, path, errors, allowedKeys) {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} contains unknown key: ${key}`);
  }
  return value;
}

export function validateArray(value, path, errors, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  if (value.length < min) errors.push(`${path} must contain at least ${min} item(s)`);
  if (value.length > max) errors.push(`${path} must contain at most ${max} item(s)`);
  return value;
}

export function validateString(value, path, errors, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return "";
  }
  if (value !== value.trim()) errors.push(`${path} must not have leading or trailing whitespace`);
  if (!allowEmpty && !value.trim()) errors.push(`${path} must be a non-empty string`);
  return value;
}

export function validateNullableString(value, path, errors) {
  if (value === null) return null;
  return validateString(value, path, errors);
}

export function validateStringArray(value, path, errors, options) {
  const items = validateArray(value, path, errors, options);
  items.forEach((item, index) => validateString(item, `${path}[${index}]`, errors));
  return items;
}

export function validateBoolean(value, path, errors) {
  if (typeof value !== "boolean") errors.push(`${path} must be a boolean`);
  return value;
}

export function validateInteger(value, path, errors, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min) {
    errors.push(`${path} must be an integer greater than or equal to ${min}`);
  }
  return value;
}

export function validateEnum(value, path, errors, allowedValues, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!allowedValues.includes(value)) {
    const rendered = allowedValues.map((item) => JSON.stringify(item)).join(", ");
    errors.push(`${path} must be one of: ${rendered}${nullable ? ", null" : ""}`);
  }
  return value;
}

export function validateIsoTimestamp(value, path, errors) {
  const timestamp = validateString(value, path, errors);
  if (!timestamp) return timestamp;
  const match = timestamp.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  let valid = Boolean(match) && Number.isFinite(Date.parse(timestamp));
  if (match) {
    const [
      ,
      yearText,
      monthText,
      dayText,
      hourText,
      minuteText,
      secondText,
      offsetHourText,
      offsetMinuteText,
    ] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const daysInMonth =
      month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
    valid =
      valid &&
      day >= 1 &&
      day <= daysInMonth &&
      Number(hourText) <= 23 &&
      Number(minuteText) <= 59 &&
      Number(secondText) <= 59 &&
      (offsetHourText === undefined || Number(offsetHourText) <= 23) &&
      (offsetMinuteText === undefined || Number(offsetMinuteText) <= 59);
  }
  if (!valid) {
    errors.push(`${path} must be an ISO-8601 timestamp with a timezone`);
  }
  return timestamp;
}

export function validateHttpUrl(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  const urlValue = validateString(value, path, errors);
  if (!urlValue) return urlValue;
  try {
    const parsed = new URL(urlValue);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      errors.push(`${path} must use http or https`);
    }
  } catch {
    errors.push(`${path} must be a valid URL`);
  }
  return urlValue;
}

export function validateRepoRelativePath(value, path, errors, { expectedPath } = {}) {
  const artifactPath = validateString(value, path, errors);
  if (!artifactPath) return artifactPath;
  if (artifactPath.includes("\\") || artifactPath.startsWith("/") || artifactPath.endsWith("/")) {
    errors.push(`${path} must be a normalized repo-relative path`);
  }
  const parts = artifactPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    errors.push(`${path} must not contain empty or dot path segments`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(artifactPath)) {
    errors.push(`${path} must not contain control characters`);
  }
  if (artifactPath !== artifactPath.normalize("NFC")) {
    errors.push(`${path} must use Unicode NFC normalization`);
  }
  if (expectedPath !== undefined && artifactPath !== expectedPath) {
    errors.push(`${path} must equal ${expectedPath}`);
  }
  return artifactPath;
}

export function validateOutputDir(value, path, errors) {
  const outputDir = validateRepoRelativePath(value, path, errors);
  const [root, segment, ...extra] = typeof outputDir === "string" ? outputDir.split("/") : [];
  if (root !== "output" || !segment || extra.length) {
    errors.push(`${path} must have exactly one child segment under output/`);
    return outputDir;
  }
  if (!OUTPUT_SEGMENT_PATTERN.test(segment)) {
    errors.push(
      `${path} segment must contain lowercase Unicode letters/numbers separated by single hyphens`,
    );
  }
  if (segment !== segment.toLowerCase()) {
    errors.push(`${path} segment must use locale-independent lowercase`);
  }
  return outputDir;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateSha256(value, path, errors) {
  const digest = validateString(value, path, errors);
  if (digest && !SHA256_PATTERN.test(digest)) {
    errors.push(`${path} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return digest;
}

export function validateUtf8TextBytes(bytes, path, errors) {
  if (!(bytes instanceof Uint8Array)) {
    errors.push(`${path} must be supplied as bytes`);
    return "";
  }
  if (bytes.byteLength === 0) {
    errors.push(`${path} must be non-empty`);
    return "";
  }
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    errors.push(`${path} must contain valid UTF-8`);
    return "";
  }
  if (!text.trim()) errors.push(`${path} must contain non-whitespace text`);
  if (text.includes("\u0000")) errors.push(`${path} must not contain NUL bytes`);
  return text;
}

export function parseJsonBytes(bytes, path, errors) {
  const text = validateUtf8TextBytes(bytes, path, errors);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    errors.push(`${path} must contain valid JSON`);
    return undefined;
  }
}

export function validateFileReference(
  value,
  path,
  errors,
  { expectedPath, schemaVersion = "required", expectedSchemaVersion, contentBytes } = {},
) {
  const allowedKeys =
    schemaVersion === "omit"
      ? ["path", "sha256", "bytes"]
      : ["path", "schemaVersion", "sha256", "bytes"];
  const reference = validateStrictObject(value, path, errors, allowedKeys);
  validateRepoRelativePath(reference.path, `${path}.path`, errors, { expectedPath });

  if (schemaVersion !== "omit") {
    if (reference.schemaVersion !== null) {
      validateInteger(reference.schemaVersion, `${path}.schemaVersion`, errors, { min: 1 });
    }
    if (expectedSchemaVersion !== undefined && reference.schemaVersion !== expectedSchemaVersion) {
      errors.push(`${path}.schemaVersion must equal ${JSON.stringify(expectedSchemaVersion)}`);
    }
  }

  const digest = validateSha256(reference.sha256, `${path}.sha256`, errors);
  const byteLength = validateInteger(reference.bytes, `${path}.bytes`, errors, { min: 1 });
  if (contentBytes !== undefined) {
    if (!(contentBytes instanceof Uint8Array)) {
      errors.push(`${path} content must be supplied as bytes`);
    } else {
      const actualDigest = sha256Hex(contentBytes);
      if (digest && digest !== actualDigest) {
        errors.push(`${path}.sha256 does not match the referenced file bytes`);
      }
      if (Number.isSafeInteger(byteLength) && byteLength !== contentBytes.byteLength) {
        errors.push(`${path}.bytes does not match the referenced file byte size`);
      }
    }
  }
  return reference;
}
