/**
 * One error type for every caller mistake the collector can make.
 *
 * A caller error is not an observation about a channel. That a channel is a group, does not exist,
 * or answered 429 is a value the sweep returns and the report prints; what throws is being pointed
 * at something unreadable - a config that fails its schema, a state file that was never
 * initialised, an output directory that already holds a sweep.
 *
 * No message here echoes page content, a post title or a link. A config error names an entry index,
 * a state error names the rule, and a bounded code names the failure: a message built from a
 * hostile post is a message a model later reads.
 */
export const errorCodes = Object.freeze([
  "already_completed",
  "answers_invalid",
  "answers_missing",
  "argv_invalid",
  "config_changed",
  "config_invalid",
  "config_missing",
  "config_unreadable",
  "handle_invalid",
  "out_dir_invalid",
  "out_dir_not_empty",
  "source_set_invalid",
  "stage_invalid",
  "stage_missing",
  "state_changed",
  "state_exists",
  "state_invalid",
  "state_kind_mismatch",
  "state_missing",
]);

export class TelegramCollectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TelegramCollectError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new TelegramCollectError(code, message);
}
