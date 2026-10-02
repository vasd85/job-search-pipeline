import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPublicLinks } from "../tools/public-links.mjs";
const exclusions={exclude:[{path:"private/",kind:"directory"}],keep:[]};
function tree(t,files){const root=mkdtempSync(join(tmpdir(),"job-search-public-links-"));t.after(()=>rmSync(root,{recursive:true,force:true}));for(const [p,text]of Object.entries(files)){mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),text);}return root;}
test("checks file, heading, encoded and reference links including ADR documents",t=>{
 const root=tree(t,{"README.md":"[ADR](docs/adr/a.md#heading)\n[space](docs/with%20space.md)\n[ref]: docs/adr/a.md#heading\n[web](https://example.org/missing)\n","docs/adr/a.md":"# Heading\n","docs/with space.md":"# Space\n"});
 assert.deepEqual(checkPublicLinks({root,exclusions}),[]);
 writeFileSync(join(root,"docs/adr/a.md"),"# Renamed\n[missing](absent.md)\n");
 assert.equal(checkPublicLinks({root,exclusions}).length,3);
});
test("private path, missing path, root escape, bad encoding and nonexistent anchor refuse",t=>{
 const root=tree(t,{"README.md":"[private](private/a.md)\n[missing](absent.md)\n[escape](../a.md)\n[encoding](%XX.md)\n[heading](#missing)\n","private/a.md":"# Private\n"});
 assert.equal(checkPublicLinks({root,exclusions}).length,5);
});
test("layer links require the tracked example rather than a real private layer",t=>{
 const root=tree(t,{"README.md":"[layer](candidate/profile.md#profile)\n","candidate.example/profile.md":"# Profile\n","candidate/profile.md":"# Wrong\n"});
 assert.deepEqual(checkPublicLinks({root,exclusions}),[]);
 writeFileSync(join(root,"candidate.example/profile.md"),"# Wrong\n");
 assert.equal(checkPublicLinks({root,exclusions}).length,1);
});
test("links cannot follow symlinks",t=>{
 const root=tree(t,{"README.md":"[link](alias.md)\n","target.md":"# Heading\n"});symlinkSync("target.md",join(root,"alias.md"));
 assert.equal(checkPublicLinks({root,exclusions}).length,1);
});

test("links cannot pass through a symbolic-link parent", t => {
 const root = tree(t, {"README.md":"[nested](alias/file.md)\n", "actual/file.md":"# Heading\n"});
 symlinkSync("actual", join(root,"alias"));
 assert.equal(checkPublicLinks({root,exclusions}).length, 1);
});

test("all published Markdown links in the repository resolve", () => {
 const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
 assert.deepEqual(checkPublicLinks({root}), []);
});


test("nested engine candidate tools are scanned while the root private layer is omitted", t => {
 const root = tree(t, {"tools/candidate/README.md":"[broken](absent.md)\n", "candidate/private.md":"[private](absent.md)\n"});
 assert.deepEqual(checkPublicLinks({root,exclusions}), [{path:"tools/candidate/README.md",line:1,reason:"Local link target is absent from the public snapshot."}]);
});

test("Markdown code examples are text, while adjacent rendered links remain checked", t => {
 const root = tree(t, {"README.md":"`[words](ghost.md)`\n``[words](other.md)``\n```markdown\n[words](fenced.md)\n```\n~~~markdown\n[words](tilde.md)\n~~~\n[actual](missing.md)\n"});
 assert.deepEqual(checkPublicLinks({root,exclusions}), [{path:"README.md",line:9,reason:"Local link target is absent from the public snapshot."}]);
});


test("unmatched delimiter runs and separate blocks cannot hide rendered links", t => {
 for (const text of ["``[actual](missing.md)`\n", "`unclosed\n\n[actual](missing.md)\n\nclosing`\n", "`unclosed\n# [actual](missing.md)\nclosing`\n"]) {
  const root = tree(t, {"README.md":text});
  assert.equal(checkPublicLinks({root,exclusions}).length, 1);
 }
});


test("escaped openings and invalid fence info cannot hide rendered links", t => {
 for (const text of ["\\`[actual](missing.md)`\n", "```not`fence\n[actual](missing.md)\n"]) {
  const root = tree(t, {"README.md":text});
  assert.equal(checkPublicLinks({root,exclusions}).length, 1);
 }
 const root = tree(t, {"README.md":"\\\\`[code](missing.md)`\n~~~info`allowed\n[code](missing.md)\n~~~\n"});
 assert.deepEqual(checkPublicLinks({root,exclusions}), []);
});
