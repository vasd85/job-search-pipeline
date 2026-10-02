import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLibreOfficeInvocation,
  createRendererEnvironment,
  resolveLibreOfficeBackend,
} from "../tools/cv-builder/libreoffice-backend.mjs";

const systemWrapper = "/test/system/bin/soffice";
const runtimeOverride = "/test/runtime/dependencies/bin/override/soffice";
const macosApp = "/Applications/LibreOffice.app";

function resolverContext({
  pathEntries = [],
  executablePaths = [],
  directories = [macosApp],
  wrappers = {},
  env = {},
  platform = "darwin",
} = {}) {
  return {
    platform,
    env: { PATH: "", ...env },
    pathEntries,
    isExecutable(path) {
      return executablePaths.includes(path);
    },
    isDirectory(path) {
      return directories.includes(path);
    },
    readText(path) {
      return wrappers[path] ?? "";
    },
  };
}

test("explicit Python DOCX renderer has highest priority", () => {
  const backend = resolveLibreOfficeBackend(
    {
      docxRenderer: "/runtime/render_docx.py",
      python: "/runtime/python3",
    },
    resolverContext(),
  );

  assert.equal(backend.kind, "python-renderer");
  assert.equal(backend.command, "/runtime/python3");
  assert.equal(backend.renderer, "/runtime/render_docx.py");
  assert.equal(backend.emitsPageImages, true);
});

test("macOS resolver skips a system GUI wrapper and selects a later runtime headless override", () => {
  const backend = resolveLibreOfficeBackend(
    {},
    resolverContext({
      pathEntries: ["/test/system/bin", "/test/runtime/dependencies/bin/override"],
      executablePaths: [systemWrapper, runtimeOverride, "/usr/bin/open"],
      wrappers: {
        [systemWrapper]:
          '#!/bin/sh\nexec /Applications/LibreOffice.app/Contents/MacOS/soffice "$@"\n',
        [runtimeOverride]: '#!/bin/sh\nexec /runtime/libreoffice-headless/soffice "$@"\n',
      },
    }),
  );

  assert.equal(backend.kind, "headless-soffice");
  assert.equal(backend.command, runtimeOverride);
  assert.match(backend.label, /Runtime headless soffice/);
});

test("macOS resolver uses LaunchServices when only the system GUI LibreOffice is available", () => {
  const backend = resolveLibreOfficeBackend(
    {},
    resolverContext({
      pathEntries: ["/test/system/bin"],
      executablePaths: [systemWrapper, "/usr/bin/open"],
      wrappers: {
        [systemWrapper]:
          '#!/bin/sh\nexec /Applications/LibreOffice.app/Contents/MacOS/soffice "$@"\n',
      },
    }),
  );

  assert.equal(backend.kind, "macos-launchservices");
  assert.equal(backend.command, "/usr/bin/open");
  assert.equal(backend.appPath, macosApp);
});

test("configured runtime headless soffice is portable across desktop runtimes", () => {
  const configured = "/runtime/bin/soffice-headless";
  const backend = resolveLibreOfficeBackend(
    {},
    resolverContext({
      env: { CV_BUILDER_HEADLESS_SOFFICE: configured },
      executablePaths: [configured],
      directories: [],
    }),
  );

  assert.equal(backend.kind, "headless-soffice");
  assert.equal(backend.command, configured);
  assert.match(backend.label, /Configured headless soffice/);
});

test("configured system GUI soffice is rejected instead of crashing inside a sandbox", () => {
  assert.throws(
    () =>
      resolveLibreOfficeBackend(
        {},
        resolverContext({
          env: { CV_BUILDER_HEADLESS_SOFFICE: systemWrapper },
          executablePaths: [systemWrapper],
          directories: [],
          wrappers: {
            [systemWrapper]:
              '#!/bin/sh\nexec /Applications/LibreOffice.app/Contents/MacOS/soffice "$@"\n',
          },
        }),
      ),
    (error) => {
      assert.equal(error.code, "cv_renderer_unsafe_macos_soffice");
      return true;
    },
  );
});

test("missing headless runtime and macOS application fails before LibreOffice is launched", () => {
  assert.throws(
    () =>
      resolveLibreOfficeBackend(
        {},
        resolverContext({
          executablePaths: ["/usr/bin/open"],
          directories: [],
        }),
      ),
    (error) => {
      assert.equal(error.code, "cv_renderer_no_safe_backend");
      return true;
    },
  );
});

test("LaunchServices invocation always starts a separate background instance with an isolated profile", () => {
  const backend = {
    kind: "macos-launchservices",
    command: "/usr/bin/open",
    appPath: macosApp,
  };
  const first = buildLibreOfficeInvocation(backend, {
    docxPath: "/work/cv.docx",
    qaDir: "/work/qa",
    profileDir: "/work/qa/libreoffice-profile-first",
    platform: "darwin",
  });
  const second = buildLibreOfficeInvocation(backend, {
    docxPath: "/work/cv.docx",
    qaDir: "/work/qa",
    profileDir: "/work/qa/libreoffice-profile-second",
    platform: "darwin",
  });

  assert.equal(first.command, "/usr/bin/open");
  for (const flag of ["-W", "-n", "-g", "--args"]) {
    assert.equal(first.args.includes(flag), true, `missing LaunchServices flag ${flag}`);
  }
  assert.equal(first.args.includes(macosApp), true);
  assert.equal(
    first.args.includes("-env:UserInstallation=file:///work/qa/libreoffice-profile-first"),
    true,
  );
  assert.equal(
    second.args.includes("-env:UserInstallation=file:///work/qa/libreoffice-profile-second"),
    true,
  );
  assert.equal(
    first.args.includes("--pidfile=/work/qa/libreoffice-profile-first/soffice.pid"),
    true,
  );
  assert.notDeepEqual(first.args, second.args);
});

test("runtime headless invocation never routes through the system GUI application", () => {
  const invocation = buildLibreOfficeInvocation(
    {
      kind: "headless-soffice",
      command: runtimeOverride,
    },
    {
      docxPath: "/work/cv.docx",
      qaDir: "/work/qa",
      profileDir: "/work/qa/libreoffice-profile",
      platform: "darwin",
    },
  );

  assert.equal(invocation.command, runtimeOverride);
  assert.equal(invocation.args.includes("--headless"), true);
  assert.equal(
    invocation.args.some((arg) => arg.includes("/Applications/LibreOffice.app")),
    false,
  );
});

test("renderer environment normalizes macOS temp directories without replacing HOME", () => {
  const original = {
    HOME: "/Users/candidate",
    TMPDIR: "/var/folders/runtime/T",
    PATH: "/usr/bin",
  };
  const env = createRendererEnvironment(original, "darwin");

  assert.equal(env.HOME, original.HOME);
  assert.equal(env.TMPDIR, "/private/tmp");
  assert.equal(env.TEMP, "/private/tmp");
  assert.equal(env.TMP, "/private/tmp");
  assert.equal(original.TMPDIR, "/var/folders/runtime/T");
});

test("non-macOS runtimes preserve the existing PATH soffice behavior", () => {
  const backend = resolveLibreOfficeBackend(
    {},
    resolverContext({
      platform: "linux",
      directories: [],
    }),
  );

  assert.equal(backend.kind, "headless-soffice");
  assert.equal(backend.command, "soffice");
});
