import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_MACOS_LIBREOFFICE_APP = "/Applications/LibreOffice.app";
export const DEFAULT_RENDER_TIMEOUT_MS = 120_000;

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readSmallTextFile(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > 64 * 1024) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function isRuntimeOverridePath(path) {
  const overrideDir = dirname(path);
  return (
    basename(overrideDir) === "override" &&
    basename(dirname(overrideDir)) === "bin" &&
    basename(dirname(dirname(overrideDir))) === "dependencies"
  );
}

function looksLikeSystemMacosGuiSoffice(path, readText) {
  const normalized = normalize(path);
  if (normalized.includes("/Applications/LibreOffice.app/Contents/MacOS/soffice")) return true;
  const wrapper = readText(path);
  return wrapper.includes("/Applications/LibreOffice.app/Contents/MacOS/soffice");
}

function runtimeHeadlessCandidate(path, { executable, readText }) {
  if (!executable(path) || looksLikeSystemMacosGuiSoffice(path, readText)) return false;
  if (isRuntimeOverridePath(path)) return true;
  return readText(path).includes("libreoffice-headless");
}

function rendererError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * Select a renderer without starting LibreOffice. On macOS, a system GUI soffice is never launched
 * directly: runtime-provided headless builds are preferred and LaunchServices is the safe fallback.
 */
export function resolveLibreOfficeBackend(options = {}, context = {}) {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const executable = context.isExecutable ?? isExecutableFile;
  const directory = context.isDirectory ?? isDirectory;
  const readText = context.readText ?? readSmallTextFile;
  const pathEntries =
    context.pathEntries ??
    String(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean);

  if (options.docxRenderer) {
    return {
      kind: "python-renderer",
      command: options.python,
      renderer: options.docxRenderer,
      emitsPageImages: true,
      label: `Python DOCX renderer: ${options.docxRenderer}`,
    };
  }

  const configuredHeadless = env.CV_BUILDER_HEADLESS_SOFFICE;
  if (configuredHeadless) {
    if (!isAbsolute(configuredHeadless)) {
      throw rendererError(
        "cv_renderer_invalid_headless_soffice",
        "CV_BUILDER_HEADLESS_SOFFICE must be an absolute path",
      );
    }
    if (!executable(configuredHeadless)) {
      throw rendererError(
        "cv_renderer_invalid_headless_soffice",
        `configured executable does not exist or is not executable: ${configuredHeadless}`,
      );
    }
    if (platform === "darwin" && looksLikeSystemMacosGuiSoffice(configuredHeadless, readText)) {
      throw rendererError(
        "cv_renderer_unsafe_macos_soffice",
        "CV_BUILDER_HEADLESS_SOFFICE points to the system GUI LibreOffice; configure a headless runtime binary or use LaunchServices",
      );
    }
    return {
      kind: "headless-soffice",
      command: configuredHeadless,
      emitsPageImages: false,
      label: `Configured headless soffice: ${configuredHeadless}`,
    };
  }

  if (platform === "darwin") {
    for (const pathEntry of pathEntries) {
      const candidate = join(pathEntry, "soffice");
      if (!runtimeHeadlessCandidate(candidate, { executable, readText })) continue;
      return {
        kind: "headless-soffice",
        command: candidate,
        emitsPageImages: false,
        label: `Runtime headless soffice: ${candidate}`,
      };
    }

    const appPath = env.CV_BUILDER_LIBREOFFICE_APP || DEFAULT_MACOS_LIBREOFFICE_APP;
    if (!isAbsolute(appPath)) {
      throw rendererError(
        "cv_renderer_invalid_macos_app",
        "CV_BUILDER_LIBREOFFICE_APP must be an absolute application path",
      );
    }
    if (!directory(appPath)) {
      throw rendererError(
        "cv_renderer_no_safe_backend",
        `no runtime headless soffice was found and the LibreOffice application is unavailable: ${appPath}`,
      );
    }
    if (!executable("/usr/bin/open")) {
      throw rendererError(
        "cv_renderer_no_safe_backend",
        "macOS LaunchServices command /usr/bin/open is unavailable",
      );
    }
    return {
      kind: "macos-launchservices",
      command: "/usr/bin/open",
      appPath,
      emitsPageImages: false,
      label: `macOS LaunchServices isolated LibreOffice: ${appPath}`,
    };
  }

  return {
    kind: "headless-soffice",
    command: "soffice",
    emitsPageImages: false,
    label: "PATH headless soffice",
  };
}

export function createRendererEnvironment(baseEnv = process.env, platform = process.platform) {
  const env = { ...baseEnv };
  if (platform === "darwin") {
    env.TMPDIR = "/private/tmp";
    env.TEMP = "/private/tmp";
    env.TMP = "/private/tmp";
  }
  return env;
}

export function buildLibreOfficeInvocation(
  backend,
  { docxPath, qaDir, profileDir, platform = process.platform },
) {
  if (backend.kind === "python-renderer") {
    return {
      command: backend.command,
      args: [backend.renderer, docxPath, "--output_dir", qaDir, "--emit_pdf"],
      timeoutMs: DEFAULT_RENDER_TIMEOUT_MS,
    };
  }

  if (!profileDir) {
    throw rendererError(
      "cv_renderer_profile_required",
      `renderer backend ${backend.kind} requires an isolated LibreOffice profile`,
    );
  }

  const profileUrl = pathToFileURL(profileDir).href;
  const pidFile = join(profileDir, "soffice.pid");
  const conversionArgs = [
    `-env:UserInstallation=${profileUrl}`,
    "--headless",
    "--nologo",
    "--nodefault",
    "--norestore",
    `--pidfile=${pidFile}`,
    "--convert-to",
    "pdf",
    "--outdir",
    qaDir,
    docxPath,
  ];

  if (backend.kind === "headless-soffice") {
    return {
      command: backend.command,
      args: conversionArgs,
      timeoutMs: DEFAULT_RENDER_TIMEOUT_MS,
      pidFile,
      processMatchToken: profileUrl,
    };
  }

  if (backend.kind === "macos-launchservices") {
    const instanceName = basename(profileDir);
    const stdoutLog = join(qaDir, `${instanceName}.stdout.log`);
    const stderrLog = join(qaDir, `${instanceName}.stderr.log`);
    const args = [
      "-W",
      "-n",
      "-g",
      "-a",
      backend.appPath,
      "--stdout",
      stdoutLog,
      "--stderr",
      stderrLog,
    ];
    if (platform === "darwin") {
      args.push(
        "--env",
        "TMPDIR=/private/tmp",
        "--env",
        "TEMP=/private/tmp",
        "--env",
        "TMP=/private/tmp",
      );
    }
    args.push("--args", ...conversionArgs);
    return {
      command: backend.command,
      args,
      timeoutMs: DEFAULT_RENDER_TIMEOUT_MS,
      stdoutLog,
      stderrLog,
      pidFile,
      processMatchToken: profileUrl,
    };
  }

  throw rendererError(
    "cv_renderer_unknown_backend",
    `unsupported LibreOffice backend: ${backend.kind}`,
  );
}
