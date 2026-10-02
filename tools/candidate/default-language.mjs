/**
 * The default language: the one language the engine knows by name. Every other language is the
 * candidate layer's (`languages.mjs`). This module holds the constant alone and reads nothing, so a
 * pure module — the scorer above all — can name the default without importing a reader of files.
 * The signature of a letter in it is the candidate's and comes from `letter.signature` in the config.
 */
export const DEFAULT_LANGUAGE = Object.freeze({
  admitsScripts: Object.freeze([]),
  locale: "en",
  name: "English",
  script: "Latin",
  subjectPrefix: "Subject",
});
