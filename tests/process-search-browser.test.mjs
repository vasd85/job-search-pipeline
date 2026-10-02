import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { RESEARCH_CATEGORIES } from "../tools/pipeline-artifacts/validate-company-research.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const browserCandidates = [
  process.env.JOB_PIPELINE_BROWSER_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitForChildExit(child, label, timeout = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`${label} did not exit within ${timeout}ms`));
    }, timeout);
    const onExit = () => {
      cleanup();
      resolveExit();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

async function terminateChild(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulExit = waitForChildExit(child, label);
  child.kill("SIGTERM");
  try {
    await gracefulExit;
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const forcedExit = waitForChildExit(child, label);
    child.kill("SIGKILL");
    await forcedExit;
  }
}

function waitForJsonLine(child, label) {
  return new Promise((resolveLine, rejectLine) => {
    let stdout = "";
    let stderr = "";
    const onData = (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try {
        resolveLine(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        rejectLine(new Error(`${label} returned invalid JSON: ${error.message}`));
      }
    };
    const onError = (error) => {
      cleanup();
      rejectLine(error);
    };
    const onExit = (code) => {
      cleanup();
      rejectLine(
        new Error(`${label} exited before ready (${code}): ${stderr.trim()}`),
      );
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onStderr = (chunk) => {
      stderr += chunk;
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForDevTools(profilePath, child, { timeoutMs = 10_000 } = {}) {
  let stderr = "";
  let truncated = false;
  let spawnError = null;
  let closed = child.exitCode !== null || child.signalCode !== null;
  const onStderr = (chunk) => {
    stderr += chunk;
    if (stderr.length > 8_192) {
      truncated = true;
      stderr = stderr.slice(-8_192);
    }
  };
  // Drain for the child's whole lifetime, including after DevTools becomes ready.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", onStderr);
  child.once("error", (error) => { spawnError = error; });
  child.once("close", () => {
    closed = true;
    child.stderr.off("data", onStderr);
  });
  const failure = (message) => new Error(
    `${message}; exit code: ${child.exitCode}; signal: ${child.signalCode}`
      + `; stderr${truncated ? " (tail)" : ""}: ${stderr.trim() || "<empty>"}`,
  );
  const activePortPath = join(profilePath, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw failure(`browser could not start (${spawnError.code ?? spawnError.message})`);
    }
    if (closed) {
      throw failure("browser exited before DevTools was ready");
    }
    if (existsSync(activePortPath)) {
      const [port] = readFileSync(activePortPath, "utf8").trim().split("\n");
      if (/^\d+$/.test(port)) return Number.parseInt(port, 10);
    }
    await delay(50);
  }
  throw failure("browser DevTools endpoint did not become ready");
}

function startupFixture(t, source) {
  const profile = mkdtempSync(join(tmpdir(), "job-pipeline-startup-"));
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(async () => {
    await terminateChild(child, "startup fixture");
    rmSync(profile, { recursive: true, force: true });
  });
  return { profile, child };
}

test("browser startup reports fatal stderr and exit code", async (t) => {
  const { profile, child } = startupFixture(t,
    'process.stderr.write("fatal browser startup\\n"); process.exitCode = 42;');
  await assert.rejects(waitForDevTools(profile, child), (error) => {
    assert.match(error.message, /browser exited before DevTools was ready/);
    assert.match(error.message, /exit code: 42/);
    assert.match(error.message, /fatal browser startup/);
    return true;
  });
});

test("browser startup reports a signal instead of hiding it as a timeout", async (t) => {
  const { profile, child } = startupFixture(t,
    'process.stderr.write("sandbox startup failed\\n", () => process.kill(process.pid, "SIGTERM"));');
  await assert.rejects(waitForDevTools(profile, child), (error) => {
    assert.match(error.message, /browser exited before DevTools was ready/);
    assert.match(error.message, /signal: SIGTERM/);
    assert.match(error.message, /sandbox startup failed/);
    return true;
  });
});

test("browser startup drains large stderr and retains a bounded tail", async (t) => {
  const { profile, child } = startupFixture(t,
    'process.stderr.write("discard-this-prefix" + "x".repeat(512 * 1024) + "fatal-tail", () => { process.exitCode = 43; });');
  await assert.rejects(waitForDevTools(profile, child), (error) => {
    assert.match(error.message, /exit code: 43/);
    assert.match(error.message, /fatal-tail/);
    assert.doesNotMatch(error.message, /discard-this-prefix/);
    assert.ok(error.message.length < 9_000);
    return true;
  });
});

test("browser startup timeout reports stderr and the running process", async (t) => {
  const { profile, child } = startupFixture(t,
    'process.stderr.write("startup stalled\\n"); setInterval(() => {}, 1000);');
  await assert.rejects(waitForDevTools(profile, child, { timeoutMs: 2_000 }), (error) => {
    assert.match(error.message, /browser DevTools endpoint did not become ready/);
    assert.match(error.message, /exit code: null; signal: null/);
    assert.match(error.message, /startup stalled/);
    return true;
  });
});

test("browser startup reports a missing executable", async (t) => {
  const profile = mkdtempSync(join(tmpdir(), "job-pipeline-startup-"));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const child = spawn(join(profile, "missing-browser"), [], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  await assert.rejects(waitForDevTools(profile, child), (error) => {
    assert.match(error.message, /browser could not start/);
    assert.match(error.message, /ENOENT/);
    return true;
  });
});

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      const waiters = this.waiters.get(message.method);
      if (!waiters?.length) return;
      this.waiters.delete(message.method);
      for (const waiter of waiters) waiter.resolve(message.params);
    });
  }

  static connect(url) {
    return new Promise((resolveClient, rejectClient) => {
      const socket = new WebSocket(url);
      socket.addEventListener(
        "open",
        () => resolveClient(new CdpClient(socket)),
        { once: true },
      );
      socket.addEventListener("error", rejectClient, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, {
        resolve: resolveCommand,
        reject: rejectCommand,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeout = 10_000) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        const waiters = this.waiters.get(method) ?? [];
        this.waiters.set(
          method,
          waiters.filter((waiter) => waiter.resolve !== onResolve),
        );
        rejectEvent(new Error(`timed out waiting for ${method}`));
      }, timeout);
      const onResolve = (value) => {
        clearTimeout(timer);
        resolveEvent(value);
      };
      const waiters = this.waiters.get(method) ?? [];
      waiters.push({ resolve: onResolve });
      this.waiters.set(method, waiters);
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? "browser evaluation failed");
  }
  return response.result.value;
}

async function navigate(client, url) {
  const loaded = client.waitFor("Page.loadEventFired");
  await client.send("Page.navigate", { url });
  await loaded;
}

async function waitForText(client, text) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = await evaluate(
      client,
      `document.body?.innerText.includes(${JSON.stringify(text)}) ?? false`,
    );
    if (found) return;
    await delay(50);
  }
  throw new Error(`browser text did not appear: ${text}`);
}

async function browserBody(client) {
  return evaluate(client, "document.body.innerText");
}

async function startFixtureServer(t) {
  const fixtureServer = spawn(
    process.execPath,
    ["tests/fixtures/process-search-ui-server.mjs"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        JOB_PIPELINE_SEARCH_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => terminateChild(fixtureServer, "fixture server"));
  return waitForJsonLine(fixtureServer, "fixture server");
}

// The first cells of the source-coverage table and every quote's translation paragraph, read from
// the company research as the reader renders it.
async function readResearchView(client, fixture) {
  await navigate(
    client,
    `${fixture.url}/processes/${encodeURIComponent(fixture.processId)}`,
  );
  await waitForText(client, "DOCX published; review required");
  await evaluate(
    client,
    `[...document.querySelectorAll(".artifact-nav-button")]
      .find((candidate) => candidate.textContent.includes("Company research"))
      ?.click()`,
  );
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = await evaluate(
      client,
      `(() => {
        const reader = document.querySelector(".reader-content");
        const coverage = [...(reader?.querySelectorAll(".semantic-section") ?? [])]
          .find((section) => section.querySelector("h3")?.textContent === "Source coverage");
        if (!coverage) return null;
        return {
          categories: [...coverage.querySelectorAll("tbody tr td:first-child")]
            .map((cell) => cell.textContent),
          translations: [...reader.querySelectorAll("blockquote .translation")]
            .map((node) => node.textContent),
        };
      })()`,
    );
    if (view) return view;
    await delay(50);
  }
  throw new Error("the company research did not render its source coverage");
}

test(
  "browser app renders honest publication state across success, error, retry, and narrow views",
  { timeout: 45_000 },
  async (t) => {
    const browserBin = browserCandidates.find((candidate) =>
      existsSync(candidate));
    assert.ok(
      browserBin,
      "set JOB_PIPELINE_BROWSER_BIN to a Chrome/Chromium executable",
    );

    const fixture = await startFixtureServer(t);

    const profilePath = mkdtempSync(
      join(tmpdir(), "job-pipeline-browser-profile-"),
    );
    const browser = spawn(
      browserBin,
      [
        "--headless=new",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-gpu",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-default-browser-check",
        "--no-first-run",
        "--remote-debugging-port=0",
        `--user-data-dir=${profilePath}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    t.after(async () => {
      await terminateChild(browser, "browser");
      rmSync(profilePath, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 50,
      });
    });

    const devToolsPort = await waitForDevTools(profilePath, browser);
    const targets = await (
      await fetch(`http://127.0.0.1:${devToolsPort}/json/list`)
    ).json();
    const page = targets.find((target) => target.type === "page");
    assert.ok(page?.webSocketDebuggerUrl, "browser page target is required");
    const client = await CdpClient.connect(page.webSocketDebuggerUrl);
    t.after(() => client.close());
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Network.enable"),
    ]);
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await navigate(client, `${fixture.url}/`);
    await waitForText(client, "DOCX published; review required");
    let body = await browserBody(client);
    assert.match(body, /Manual review required/);
    assert.match(body, /docs\/runbooks\/application-readiness-checklist\.md/);
    assert.doesNotMatch(body, /CV ready|ready to send|ready_to_send/i);
    assert.equal(
      await evaluate(
        client,
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
      true,
    );

    await navigate(
      client,
      `${fixture.url}/processes/${encodeURIComponent(fixture.processId)}`,
    );
    await waitForText(client, "DOCX published; review required");
    body = await browserBody(client);
    assert.match(body, /The files are published and intact/);
    assert.match(body, /Manual review required/);
    assert.doesNotMatch(body, /CV ready|ready to send|ready_to_send/i);
    assert.equal(
      await evaluate(
        client,
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
      true,
    );

    // The reader auto-selects the first artifact, which is the job description, so the brief has to
    // be opened explicitly. Every assertion below is scoped to the card it is about: the job
    // description is a <pre> of the whole vacancy text, and a whole-page innerText match could stay
    // green while the reader never switched.
    await t.test("application brief renders the gap fields the contract defines", async () => {
      const opened = await evaluate(
        client,
        `(() => {
          const button = [...document.querySelectorAll(".artifact-nav-button")]
            .find((candidate) => candidate.textContent.includes("Application brief"));
          if (!button) return false;
          button.click();
          return true;
        })()`,
      );
      assert.equal(opened, true, "the Application brief artifact button must exist");
      await waitForText(client, "gap-cypress");

      const view = await evaluate(
        client,
        `(() => {
          const text = (node) => node.textContent.trim();
          const section = (title) => [...document.querySelectorAll(".semantic-section")]
            .find((node) => node.querySelector("h3")?.textContent === title);
          const claimIds = (title) =>
            [...(section(title)?.querySelectorAll(".compact-card .claim-id") ?? [])].map(text);
          // Scoped to the Gaps section, not to the document: moving the cards out of that section,
          // or renaming it, must fail here rather than keep passing on a stray selector.
          const gapCards = [...(section("Gaps")?.querySelectorAll(".gap-card") ?? [])];
          return {
            readerHeading: document.querySelector(".reader-heading h3")?.textContent ?? null,
            gapCardsOutsideSection:
              document.querySelectorAll(".gap-card").length - gapCards.length,
            gapIds: gapCards.map((card) =>
              [...card.querySelectorAll(".claim-id")].map(text)),
            gapClassifications: gapCards.map((card) => {
              const badge = card.querySelector(".gap-classification[data-classification]");
              return badge ? [badge.dataset.classification, text(badge)] : null;
            }),
            gapRequirements: gapCards.map((card) => {
              const heading = card.querySelector("h4");
              return heading ? text(heading) : null;
            }),
            gapParagraphs: gapCards.map((card) =>
              [...card.querySelectorAll("p")].map(text)),
            gapSupportLines: gapCards.map((card) =>
              [...card.querySelectorAll("small")].map(text)),
            evidenceIds: claimIds("Selected evidence"),
            traitIds: claimIds("Traits"),
            fitsViewport:
              document.documentElement.scrollWidth <= window.innerWidth,
          };
        })()`,
      );

      assert.equal(view.readerHeading, "Application brief");
      assert.equal(view.gapCardsOutsideSection, 0);
      assert.deepEqual(view.gapIds, [
        ["gap-cypress"],
        ["gap-team-leadership"],
        ["gap-kubernetes-infra"],
      ]);
      assert.deepEqual(view.gapClassifications, [
        ["hard", "hard"],
        ["soft", "soft"],
        ["adjacent", "adjacent"],
      ]);
      assert.deepEqual(view.gapRequirements, [
        "Cypress end-to-end suite ownership",
        "Formal line management of a quality engineering team",
        "Kubernetes-based test infrastructure ownership",
      ]);
      assert.deepEqual(view.gapParagraphs, [
        ["Never claim Cypress. Say plainly that the framework depth was built in Playwright, and describe how the typed layers, fixtures, and auth strategies carry over."],
        ["Do not imply a manager title. Describe the shared conventions and architectural boundaries the team adopted, and keep the claim at technical ownership."],
        ["Position the RPC interception and wallet infrastructure work as the closest real experience, and name where that boundary ends instead of stretching it."],
      ]);
      assert.deepEqual(view.gapSupportLines, [
        ["Transferable evidence deliberately not declared."],
        ["Transferable evidence: evidence-framework"],
        ["Transferable evidence: evidence-framework, evidence-web3"],
      ]);
      assert.deepEqual(view.evidenceIds, [
        "evidence-framework · primary · Achievement",
        "evidence-web3 · supporting · Domain experience",
        "evidence-logistics · supporting · Feasibility",
        "evidence-llm-work · required · Commercial work practice",
      ]);
      assert.deepEqual(view.traitIds, ["trait-systematic"]);
      assert.equal(view.fitsViewport, true);

      // Reopening the brief takes the reader's cached branch, which renders through a different
      // path than the first read. Without this the gap cards are only ever proven on a cold read.
      const reopened = await evaluate(
        client,
        `(() => {
          const open = (label) => [...document.querySelectorAll(".artifact-nav-button")]
            .find((candidate) => candidate.textContent.includes(label))?.click();
          open("Job description");
          open("Application brief");
          return true;
        })()`,
      );
      assert.equal(reopened, true);
      await waitForText(client, "Cypress end-to-end suite ownership");
      assert.deepEqual(
        await evaluate(
          client,
          `[...document.querySelectorAll(".gap-card h4")].map((node) => node.textContent)`,
        ),
        [
          "Cypress end-to-end suite ownership",
          "Formal line management of a quality engineering team",
          "Kubernetes-based test infrastructure ownership",
        ],
      );
    });

    // The page-level `scrollWidth <= innerWidth` legs above cannot see a clipped semantic view:
    // `.artifact-workspace` hides its own overflow, so a view wider than the reader leaves the
    // document exactly as wide as the viewport while every section is cut off on the right. This
    // measures inside that clipping box. It runs at the 390 px viewport already set above and again
    // at 700 px, just above the `@media (max-width: 680px)` breakpoint, where
    // `.data-table { min-width: 620px }` does not apply at all and the table's own min-content
    // width stretches the view instead — a containment hidden inside that media query passes the
    // first viewport and fails the second.
    //
    // What this does not prove, measured rather than assumed. It covers the structural stretch, the
    // one that does not depend on the data. Inline content that cannot be broken still escapes its
    // card: putting a 60-character unbroken token into the card text in the page makes the reader
    // report 397 against 315 at 390 px and 412 against 401 at 700 px for the application brief,
    // while the sections stay at their track width. That is a missing `overflow-wrap`, not this
    // containment. Paragraphs and `dd` already carry it, so only the other text nodes leak — the
    // brief's overflow came from list items — and the same gap is open on `.claim-id`, `small`,
    // table cells, `summary` and `.external-link`. No fixture reaches it on load, but for a narrow
    // reason worth naming rather than relying on: the longest unbreakable strings the renderers
    // emit are the 45-character source URLs in the company research, and those sit inside a
    // `<details>` that is created closed, so they are not laid out until someone opens it. The Raw
    // JSON mode is out of this loop by construction: it is a `<pre>` that scrolls itself.
    await t.test("semantic artifact views stay inside the reader at narrow widths", async () => {
      // Frozen literals rather than a list read back from the app: dropping a renderer from the
      // reader, or renaming one, must fail here instead of silently shrinking the covered set.
      const readerArtifacts = [
        { label: "Job description", semantic: false },
        { label: "Vacancy facts", semantic: true },
        { label: "Company research", semantic: true },
        { label: "Application brief", semantic: true },
        { label: "Cover letter", semantic: false },
      ];
      const narrowViewports = [390, 700];
      // The execution inventory, and only that: a case that never ran or ran twice fails here. A
      // case that ran against the wrong artifact fails earlier and louder, on the heading. It is
      // not a second product anchor — that job belongs to the nav-button check below, which is the
      // only leg comparing this literal with what the application produces.
      const expectedCases = [
        "Job description at 390px",
        "Vacancy facts at 390px",
        "Company research at 390px",
        "Application brief at 390px",
        "Cover letter at 390px",
        "Job description at 700px",
        "Vacancy facts at 700px",
        "Company research at 700px",
        "Application brief at 700px",
        "Cover letter at 700px",
      ];

      assert.deepEqual(
        await evaluate(
          client,
          `[...document.querySelectorAll(".artifact-nav-button span")]
            .map((node) => node.textContent)`,
        ),
        readerArtifacts.map((artifact) => artifact.label),
        "the reader must expose exactly the artifacts this test measures",
      );

      const measured = [];
      for (const width of narrowViewports) {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: false,
        });
        for (const artifact of readerArtifacts) {
          await evaluate(
            client,
            `[...document.querySelectorAll(".artifact-nav-button")]
              .find((candidate) => candidate.textContent.includes(${JSON.stringify(artifact.label)}))
              ?.click()`,
          );
          // Reading an artifact is asynchronous, and the heading is set synchronously by the click
          // while the body is still a loading state, so the heading alone does not prove the
          // artifact rendered. This waits for the body, and fails as a slow read rather than
          // letting a spinner be reported below as a missing section.
          let settled = false;
          for (let attempt = 0; attempt < 200 && !settled; attempt += 1) {
            settled = await evaluate(
              client,
              `document.querySelector(".reader-heading h3")?.textContent
                 === ${JSON.stringify(artifact.label)}
               && !document.querySelector(".reader-content .loading-state")`,
            );
            if (!settled) await delay(50);
          }
          assert.ok(
            settled,
            `the reader did not finish reading ${artifact.label} at ${width}px`,
          );
          const view = await evaluate(
            client,
            `(() => {
              const workspace = document.querySelector(".artifact-workspace");
              const reader = document.querySelector(".artifact-reader");
              const sections = [...reader.querySelectorAll(".semantic-section")];
              const wraps = [...reader.querySelectorAll(".data-table")]
                .map((table) => table.parentElement);
              return {
                heading: document.querySelector(".reader-heading h3")?.textContent ?? null,
                failedToRead: Boolean(reader.querySelector(".empty-state.error")),
                workspaceClientWidth: workspace.clientWidth,
                workspaceScrollWidth: workspace.scrollWidth,
                readerClientWidth: reader.clientWidth,
                readerScrollWidth: reader.scrollWidth,
                sectionCount: sections.length,
                widestSection: Math.max(
                  0,
                  ...sections.map((node) => Math.round(node.getBoundingClientRect().width)),
                ),
                wraps: wraps.map((wrap) => {
                  const before = wrap.scrollLeft;
                  wrap.scrollLeft = 9999;
                  const reachable = wrap.scrollLeft > 0;
                  wrap.scrollLeft = before;
                  return {
                    className: wrap.className,
                    clientWidth: wrap.clientWidth,
                    scrollWidth: wrap.scrollWidth,
                    reachable,
                  };
                }),
              };
            })()`,
          );
          const where = `${artifact.label} at ${width}px`;
          // Proves the reader actually switched before anything below was measured.
          assert.equal(view.heading, artifact.label, `reader did not open ${where}`);
          // A failed read empties the body, which would otherwise be reported below as a missing
          // section and blame the layout for a transport fault.
          assert.equal(view.failedToRead, false, `the reader failed to read ${where}`);
          assert.ok(view.readerClientWidth > 0, `reader has no width at ${where}`);
          // The reader legs below compare the reader with itself, so they stay green if the reader
          // itself outgrows the column it sits in. `.artifact-workspace` is the box that hides the
          // overflow, so measuring it closes the chain viewport → clipping box → reader; the second
          // leg is the one that fails when the reader escapes its own track. The first has no
          // recorded kill and is not expected to have one: the workspace is a block box of
          // automatic width, and surplus content lands in its scroll width rather than widening it.
          assert.ok(
            view.workspaceClientWidth <= width,
            `the artifact workspace is wider than the viewport at ${where}: `
              + `${view.workspaceClientWidth} > ${width}`,
          );
          assert.ok(
            view.workspaceScrollWidth <= view.workspaceClientWidth,
            `${where} overflows the clipping box: `
              + `${view.workspaceScrollWidth} > ${view.workspaceClientWidth}`,
          );
          assert.ok(
            view.readerScrollWidth <= view.readerClientWidth,
            `${where} overflows its reader: ${view.readerScrollWidth} > ${view.readerClientWidth}`,
          );
          if (artifact.semantic) {
            assert.ok(view.sectionCount > 0, `no semantic sections at ${where}`);
            // Containing the reader alone is also achieved by hiding the overflow one level down,
            // which would leave every section exactly as clipped as before.
            assert.ok(
              view.widestSection <= view.readerClientWidth,
              `a section is wider than the reader at ${where}: `
                + `${view.widestSection} > ${view.readerClientWidth}`,
            );
            assert.ok(view.wraps.length > 0, `no data table at ${where}`);
            assert.ok(
              view.wraps.every((wrap) => wrap.className === "table-wrap"),
              `a data table is not inside its scroller at ${where}`,
            );
          } else {
            // The controls are a different renderer, so their green says nothing about the legs
            // above; asserting that here keeps them from being read as coverage.
            assert.equal(view.sectionCount, 0, `${where} is not a plain-text artifact`);
          }
          if (artifact.semantic && width === 390) {
            for (const wrap of view.wraps) {
              // 620 is `.data-table { min-width: 620px }` from styles.css, deliberately duplicated
              // here because no test reads that file: the table must keep its readable width and
              // stay reachable by scrolling inside its own wrapper, not be squeezed or cut off.
              assert.ok(
                wrap.scrollWidth >= 620,
                `the table lost its readable width at ${where}: ${wrap.scrollWidth}`,
              );
              assert.ok(
                wrap.scrollWidth > wrap.clientWidth,
                `the table wrapper does not scroll at ${where}: `
                  + `${wrap.scrollWidth} vs ${wrap.clientWidth}`,
              );
              assert.ok(wrap.reachable, `the table overflow is unreachable at ${where}`);
            }
          }
          measured.push(`${view.heading} at ${width}px`);
        }
      }
      assert.deepEqual(measured, expectedCases);

      await client.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
    });

    await t.test("company research labels every coverage row", async () => {
      const current = await readResearchView(client, fixture);
      assert.equal(current.categories.length, RESEARCH_CATEGORIES.length);
      assert.deepEqual(
        current.categories.filter((label) => RESEARCH_CATEGORIES.includes(label)),
        [],
        "a current coverage category is printed by its code instead of a label",
      );
      assert.ok(current.translations.length > 0);
      assert.ok(current.translations.every((text) => text.length > 0));
    });

    await client.send("Network.setBlockedURLs", {
      urls: ["*/api/processes*"],
    });
    await navigate(client, `${fixture.url}/?error-case=1`);
    await waitForText(client, "Could not load the processes");
    body = await browserBody(client);
    assert.doesNotMatch(
      body,
      /DOCX published|The files are published and intact|CV ready/,
    );
    assert.equal(
      await evaluate(
        client,
        "document.querySelector('.empty-state.error button')?.textContent",
      ),
      "Retry",
    );

    await client.send("Network.setBlockedURLs", { urls: [] });
    await evaluate(
      client,
      "document.querySelector('.empty-state.error button').click()",
    );
    await waitForText(client, "DOCX published; review required");
    body = await browserBody(client);
    assert.match(body, /Manual review required/);
    assert.doesNotMatch(body, /CV ready|ready to send|ready_to_send/i);
  },
);
