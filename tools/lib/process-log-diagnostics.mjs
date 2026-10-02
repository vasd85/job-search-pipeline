export const processLogDiagnosticLimits = Object.freeze({
  codeMaxBytes: 64,
  detailMaxBytes: 256,
  detailsMaxItems: 8,
  messageMaxBytes: 512,
});

function immutablePatternTester(pattern) {
  return Object.freeze({
    test(value) {
      return pattern.test(value);
    },
  });
}

export const processLogStableDiagnosticCodePattern = immutablePatternTester(
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
);

export const processLogUppercaseCauseCodePattern = immutablePatternTester(/^[A-Z][A-Z0-9_]*$/);

const forbiddenDiagnosticShapes = Object.freeze([
  Object.freeze({
    id: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/u,
  }),
  Object.freeze({
    id: "credential_assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s,"']{4,}/iu,
  }),
  Object.freeze({
    id: "posix_absolute_path",
    pattern: /(?:^|[\s(=[{"'])\/(?:[^\s/]+\/)*[^\s/]+/u,
  }),
  Object.freeze({
    id: "private_key_marker",
    pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/u,
  }),
  Object.freeze({
    id: "stack_frame",
    pattern: /(?:^|\s)at\s+(?:async\s+)?(?:[^\s(]+\s+)?\([^)]*:\d+:\d+\)/u,
  }),
  Object.freeze({
    id: "stack_frame_bare",
    pattern: /(?:^|\s)at\s+(?:async\s+)?[^\s()]+:\d+:\d+(?:\s|$)/u,
  }),
  Object.freeze({
    id: "token_prefix_aws",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/u,
  }),
  Object.freeze({
    id: "token_prefix_github",
    pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/u,
  }),
  Object.freeze({
    id: "token_prefix_openai",
    pattern: /\bsk-[A-Za-z0-9_-]{8,}/u,
  }),
  Object.freeze({
    id: "token_prefix_slack",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}/u,
  }),
  Object.freeze({
    id: "unc_path",
    pattern: /(?:^|[\s(=[{"'])\\\\[^\\\s]+\\[^\\\s]+/u,
  }),
  Object.freeze({
    id: "url",
    pattern: /\b(?:https?|file):\/\/[^\s]+/iu,
  }),
  Object.freeze({
    id: "windows_absolute_path",
    pattern: /(?:^|[\s(=[{"'])[A-Za-z]:[\\/][^\s]+/u,
  }),
]);

export const processLogDiagnosticForbiddenShapeIds = Object.freeze(
  forbiddenDiagnosticShapes.map(({ id }) => id),
);

function containsUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateBoundedText(value, path, maxBytes, errors) {
  if (typeof value !== "string") return;
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    errors.push(`${path} must be at most ${maxBytes} UTF-8 bytes`);
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    errors.push(`${path} must be one-line text without control characters`);
  }
  if (containsUnpairedSurrogate(value)) {
    errors.push(`${path} must contain valid Unicode scalar text`);
  }
  for (const { id, pattern } of forbiddenDiagnosticShapes) {
    if (pattern.test(value)) {
      errors.push(`${path} contains forbidden diagnostic shape: ${id}`);
    }
  }
}

export function processLogDiagnosticProblems(value, path) {
  const errors = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return errors;
  const { codeMaxBytes, detailMaxBytes, detailsMaxItems, messageMaxBytes } =
    processLogDiagnosticLimits;
  if (typeof value.code === "string" && Buffer.byteLength(value.code, "utf8") > codeMaxBytes) {
    errors.push(`${path}.code must be at most ${codeMaxBytes} UTF-8 bytes`);
  }
  validateBoundedText(value.message, `${path}.message`, messageMaxBytes, errors);
  if (Array.isArray(value.details)) {
    if (value.details.length > detailsMaxItems) {
      errors.push(`${path}.details must contain at most ${detailsMaxItems} item(s)`);
    }
    for (const [index, detail] of value.details.entries()) {
      validateBoundedText(detail, `${path}.details[${index}]`, detailMaxBytes, errors);
    }
  }
  return errors;
}
