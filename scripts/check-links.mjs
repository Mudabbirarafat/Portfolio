/**
 * Every link on the page has to go somewhere.
 *
 * A portfolio fails in one specific way: a live demo goes down, a repo is
 * renamed, an image is dropped from a commit, and the page keeps advertising
 * it to the one visitor who matters. Nothing here is a framework - the page
 * is a single file, so the check is a regex, a fetch and a file-exists test.
 *
 * The distinction that makes this usable in CI: a 404 is a broken link and
 * fails the build, while a 403, 429 or LinkedIn's 999 means the host refused
 * to talk to a datacentre IP. That is not evidence the link is broken, so it
 * is reported and not failed on. Failing the build on those would train
 * everyone to ignore it.
 */

import { readFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "index.html");

// 60s, not 5. One of the live demos runs on a Render free instance, which
// stops when idle and takes most of a minute to wake. A shorter timeout
// reports that as a dead link every single time.
const TIMEOUT_MS = 60000;

const BLOCKED = new Set([401, 403, 405, 429, 999]);

// Tags rather than bare attributes, for two reasons. A `<link rel="preconnect">`
// carries an origin that is a connection hint, not a document, and fetching it
// gets a 404 from a host that is working perfectly. And the inline scripts
// build URLs out of template literals, so a raw attribute sweep picks up
// `${DEVICON}${it.logo}.svg` and calls it a missing file.
const HINT_RELS = new Set(["preconnect", "dns-prefetch", "preload", "modulepreload"]);
const TAGS = /<(a|img|link|script|iframe|source|embed)(\s[^>]*)>/gi;
const REL = /\srel\s*=\s*"([^"]*)"/i;
const REF = /\s(?:href|src)\s*=\s*"([^"]+)"/i;

const html = await readFile(PAGE, "utf8");

const refs = new Set();
for (const [, tag, attrs] of html.matchAll(TAGS)) {
  if (tag.toLowerCase() === "link") {
    const rel = REL.exec(attrs)?.[1] ?? "";
    if (rel.split(/\s+/).some((r) => HINT_RELS.has(r.toLowerCase()))) continue;
  }
  const ref = REF.exec(attrs)?.[1];
  // A `${` means the value was built by an inline script, not written in markup.
  if (ref && !ref.includes("${")) refs.add(ref);
}

const external = [];
const local = [];
for (const ref of refs) {
  if (/^(mailto:|tel:|#|data:|javascript:)/i.test(ref)) continue;
  if (/^https?:\/\//i.test(ref)) external.push(ref);
  else local.push(ref.split(/[?#]/)[0]);
}

const broken = [];
const blocked = [];

for (const ref of local.sort()) {
  try {
    await access(join(ROOT, decodeURIComponent(ref)));
    console.log(`  ok       ${ref}`);
  } catch {
    broken.push([ref, "missing from the repo"]);
    console.log(`  MISSING  ${ref}`);
  }
}

async function reach(url) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const opts = { redirect: "follow", signal, headers: { "user-agent": "portfolio-link-check" } };
  // Some hosts answer HEAD with 405 and are perfectly fine on GET, so a
  // non-ok HEAD is retried rather than believed.
  let res = await fetch(url, { ...opts, method: "HEAD" });
  if (!res.ok) res = await fetch(url, { ...opts, method: "GET" });
  return res;
}

const results = await Promise.all(
  external.sort().map(async (url) => {
    try {
      const res = await reach(url);
      return { url, status: res.status };
    } catch (err) {
      const why = err.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000}s` : err.message;
      return { url, error: why };
    }
  }),
);

for (const r of results.sort((a, b) => a.url.localeCompare(b.url))) {
  if (r.error) {
    broken.push([r.url, r.error]);
    console.log(`  DEAD     ${r.url}  (${r.error})`);
  } else if (BLOCKED.has(r.status)) {
    blocked.push([r.url, r.status]);
    console.log(`  blocked  ${r.url}  (http ${r.status}, not checked)`);
  } else if (r.status >= 400) {
    broken.push([r.url, `http ${r.status}`]);
    console.log(`  ${String(r.status).padEnd(8)} ${r.url}`);
  } else {
    console.log(`  ok       ${r.url}`);
  }
}

console.log(
  `\n${local.length} local, ${external.length} external, ` +
    `${blocked.length} refused to answer a bot, ${broken.length} broken`,
);

if (blocked.length) {
  console.log("\nRefused, which is not the same as broken:");
  for (const [url, status] of blocked) console.log(`  http ${status}  ${url}`);
}

if (broken.length) {
  console.log("\nBroken:");
  for (const [url, why] of broken) console.log(`  ${why.padEnd(24)} ${url}`);
  process.exit(1);
}
